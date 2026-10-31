import { Injectable } from '@nestjs/common';
import { McpAccessMode } from '@prisma/client';
import { type Doc as YDoc, encodeStateAsUpdate } from 'yjs';
import z from 'zod/v3';

import { DocReader, DocWriter } from '../../../core/doc';
import { PermissionAccess } from '../../../core/permission';
import { Models } from '../../../models';
import { DocumentRetrievalService } from '../retrieval/document';
import {
  collectUserIds,
  createTicket,
  getTicket,
  hasTicket,
  linkedDocOf,
  listBoards,
  listTickets,
  listWorkspacePages,
  loadDoc,
  type TicketContext,
  TicketError,
  type TicketUsers,
  updateTicket,
} from './tickets';

type McpTextContent = {
  type: 'text';
  text: string;
};

export type WorkspaceMcpToolResult = {
  content: McpTextContent[];
  isError?: boolean;
};

export type WorkspaceMcpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

export type WorkspaceMcpServer = {
  name: string;
  version: string;
  tools: WorkspaceMcpToolDefinition[];
};

type ToolExecutorInput<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  parser: T;
  inputSchema: Record<string, unknown>;
  execute: (
    args: z.infer<T>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

/**
 * Write access through MCP is limited to dev and canary builds on AFFiNE Cloud.
 * Self-hosted admins control who can mint tokens, so it is always available
 * there.
 */
export function mcpWriteToolsAvailable() {
  return env.dev || env.namespaces.canary || env.selfhosted;
}

function toolText(text: string): WorkspaceMcpToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

function toolError(message: string): WorkspaceMcpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// Upper bound of docs scanned when looking for ticket boards workspace-wide.
const MAX_TICKET_BOARD_SCAN = 200;
const MAX_TICKET_USERS = 1000;
const DEFAULT_TICKET_LIMIT = 50;

const ticketFieldsSchema = {
  type: 'object',
  description:
    'Field values keyed by column name (or column id). Select / multi-select take option names, member columns (e.g. Assignee) take member names or emails, dates take ISO strings, null clears a field.',
  additionalProperties: true,
};

function toInputError(error: z.ZodError) {
  const details = error.issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return toolError(`Invalid arguments: ${details || 'Invalid input'}`);
}

function abortIfNeeded(
  signal: AbortSignal
): WorkspaceMcpToolResult | undefined {
  if (signal.aborted) return toolError('Request aborted.');
  return;
}

function defineTool<T extends z.ZodTypeAny>(
  config: ToolExecutorInput<T>
): WorkspaceMcpToolDefinition {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: async (args, options) => {
      const aborted = abortIfNeeded(options.signal);
      if (aborted) return aborted;

      const parsed = config.parser.safeParse(args ?? {});
      if (!parsed.success) return toInputError(parsed.error);
      return await config.execute(parsed.data, options);
    },
  };
}

@Injectable()
export class WorkspaceMcpProvider {
  constructor(
    private readonly ac: PermissionAccess,
    private readonly reader: DocReader,
    private readonly writer: DocWriter,
    private readonly retrieval: DocumentRetrievalService,
    private readonly models: Models
  ) {}

  async for(
    userId: string,
    workspaceId: string,
    accessMode: McpAccessMode = McpAccessMode.READ_ONLY
  ): Promise<WorkspaceMcpServer> {
    await this.ac.user(userId).workspace(workspaceId).assert('Workspace.Read');

    const readDocument = defineTool({
      name: 'read_document',
      title: 'Read Document',
      description: 'Read a document with given ID',
      parser: z.object({ docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Read');
        if (!accessible) return notFoundError;

        const abortedAfterPermission = abortIfNeeded(options.signal);
        if (abortedAfterPermission) return abortedAfterPermission;

        const content = await this.reader.getDocMarkdown(
          workspaceId,
          docId,
          false
        );
        if (!content) return notFoundError;

        const abortedAfterRead = abortIfNeeded(options.signal);
        if (abortedAfterRead) return abortedAfterRead;

        return toolText(content.markdown);
      },
    });

    const docSearch = defineTool({
      name: 'doc_search',
      title: 'Document Search',
      description:
        'Search persisted workspace documents and return bounded passages with Page or canvas locators. Retrieval strategy is selected by the server and never includes files, blobs, attachments, or the web.',
      parser: z.object({
        query: z.string().trim().min(1).max(2000),
        doc_ids: z.array(z.string().min(1).max(128)).max(50).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          doc_ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 50,
          },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query, doc_ids, limit }, options) => {
        const result = await this.retrieval.search(
          { user: userId, workspace: workspaceId },
          query,
          doc_ids,
          limit ?? 10,
          options.signal
        );
        return toolText(
          JSON.stringify({
            retrieval_mode: result.retrievalMode,
            degraded_reason: result.degradedReason,
            hits: result.hits.map(hit => ({
              doc_id: hit.docId,
              title: hit.title,
              excerpt: hit.excerpt,
              visibility: hit.visibility,
              block_id: hit.blockId,
              element_id: hit.elementId,
              frame_id: hit.frameId,
            })),
          })
        );
      },
    });

    const loadYDoc = async (docId: string) => {
      const record = await this.reader.getDoc(workspaceId, docId);
      return record?.bin ? loadDoc(record.bin) : null;
    };

    const loadReadableDoc = async (docId: string) => {
      const readable = await this.ac
        .user(userId)
        .workspace(workspaceId)
        .doc(docId)
        .can('Doc.Read');
      return readable ? await loadYDoc(docId) : null;
    };

    // Workspace members plus anyone else referenced by the given docs (e.g.
    // people who have since left), so ids can be shown and matched by name,
    // and doc titles for tickets whose title links a description doc.
    let members: TicketUsers | undefined;
    let docTitles: Map<string, string> | undefined;
    const workspacePages = async () => {
      const root = await loadYDoc(workspaceId);
      const pages = root ? listWorkspacePages(root) : [];
      docTitles ??= new Map(pages.map(page => [page.id, page.title]));
      return pages;
    };
    const loadTicketContext = async (docs: YDoc[]): Promise<TicketContext> => {
      if (!members) {
        const [rows] = await this.models.workspaceUser.paginate(workspaceId, {
          first: MAX_TICKET_USERS,
          offset: 0,
        });
        members = new Map();
        for (const { user } of rows) {
          if (user) {
            members.set(user.id, {
              id: user.id,
              name: user.name,
              email: user.email,
            });
          }
        }
      }
      const users = new Map(members);
      const missing = [...new Set(docs.flatMap(collectUserIds))].filter(
        id => !users.has(id)
      );
      if (missing.length) {
        for (const user of await this.models.user.getWorkspaceUsers(missing)) {
          users.set(user.id, {
            id: user.id,
            name: user.name,
            email: user.email,
          });
        }
      }
      if (!docTitles) await workspacePages();
      return { users, docTitles };
    };

    // Readable docs of the workspace, for tools that work across projects.
    const readableWorkspaceDocs = async () => {
      const pages = await this.ac
        .user(userId)
        .workspace(workspaceId)
        .docs(
          (await workspacePages()).map(page => ({ ...page, docId: page.id })),
          'Doc.Read'
        );
      return {
        pages: pages.slice(0, MAX_TICKET_BOARD_SCAN),
        truncated: pages.length > MAX_TICKET_BOARD_SCAN,
      };
    };

    // The doc holding a ticket: the given one, or the first board in the
    // workspace that has a ticket with this id or key.
    const findTicketDoc = async (
      ticketId: string,
      docId: string | undefined,
      load: (docId: string) => Promise<YDoc | null>
    ) => {
      if (docId) {
        const doc = await load(docId);
        return doc ? { docId, doc } : null;
      }
      const { pages } = await readableWorkspaceDocs();
      for (const page of pages) {
        const doc = await loadYDoc(page.id);
        if (!doc || !hasTicket(doc, ticketId)) continue;
        const loaded = load === loadYDoc ? doc : await load(page.id);
        return loaded ? { docId: page.id, doc: loaded } : null;
      }
      return null;
    };
    const ticketNotFound = (ticketId: string, docId?: string) =>
      toolError(
        docId
          ? `Doc with id ${docId} not found.`
          : `Ticket ${ticketId} not found.`
      );

    const runTicketTool = async (
      run: () => Promise<WorkspaceMcpToolResult>
    ): Promise<WorkspaceMcpToolResult> => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof TicketError) return toolError(error.message);
        throw error;
      }
    };

    const docIdProperty = {
      type: 'string',
      description:
        'Doc containing the board. Optional: without it the workspace is searched.',
    };
    const ticketIdProperty = {
      type: 'string',
      description: 'Ticket key (e.g. SZ-12) or ticket id',
    };

    const listTicketBoards = defineTool({
      name: 'list_ticket_boards',
      title: 'List Ticket Boards',
      description:
        'List ticket boards (database blocks such as kanban or table views) with their columns and status options. Pass docId to inspect one document, or omit it to scan the workspace.',
      parser: z.object({ docId: z.string().optional() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'Only list boards inside this document',
          },
        },
        additionalProperties: false,
      },
      execute: async ({ docId }, options) =>
        runTicketTool(async () => {
          if (docId) {
            const doc = await loadReadableDoc(docId);
            if (!doc) return toolError(`Doc with id ${docId} not found.`);
            return toolText(
              JSON.stringify({
                boards: listBoards(doc).map(board => ({ docId, ...board })),
              })
            );
          }

          const { pages, truncated } = await readableWorkspaceDocs();
          const boards = [];
          for (const page of pages) {
            const aborted = abortIfNeeded(options.signal);
            if (aborted) return aborted;
            const doc = await loadYDoc(page.id);
            if (!doc) continue;
            for (const board of listBoards(doc)) {
              boards.push({ docId: page.id, docTitle: page.title, ...board });
            }
          }

          return toolText(JSON.stringify({ boards, truncated }));
        }),
    });

    const listTicketsTool = defineTool({
      name: 'list_tickets',
      title: 'List Tickets',
      description:
        "List tickets (rows of ticket boards). Without docId it searches every board in the workspace. Filter by user (an assignee or creator, by name or email), project (a board's Project column, or the board title), type, parent (sub-tasks of a ticket), status or text.",
      parser: z.object({
        docId: z.string().optional(),
        databaseId: z.string().optional(),
        user: z.string().trim().min(1).max(200).optional(),
        project: z.string().trim().min(1).max(200).optional(),
        type: z.string().trim().min(1).max(100).optional(),
        parent: z.string().trim().min(1).max(100).optional(),
        status: z.string().optional(),
        query: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description:
              'Only tickets in this document. Omit to search the workspace.',
          },
          databaseId: {
            type: 'string',
            description: 'Board id from list_ticket_boards (needs docId)',
          },
          user: {
            type: 'string',
            description:
              'Name, email or id of a person in a member column (e.g. Assignee) or the Created By column. Partial, case-insensitive.',
          },
          project: {
            type: 'string',
            description:
              "Project name, matched against the board's Project column or, without one, the board title. Partial, case-insensitive.",
          },
          type: {
            type: 'string',
            description:
              'Ticket type from the Type column, e.g. Bug or Sub-task',
          },
          parent: {
            type: 'string',
            description:
              'Key or id of a ticket: returns its children (sub-tasks, or the stories of an epic)',
          },
          status: {
            type: 'string',
            description: 'Only tickets with this status (case-insensitive)',
          },
          query: {
            type: 'string',
            description: 'Text matched against titles and field values',
          },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      execute: async (
        {
          docId,
          databaseId,
          user,
          project,
          type,
          parent,
          status,
          query,
          limit,
        },
        options
      ) =>
        runTicketTool(async () => {
          if (databaseId && !docId) {
            return toolError('databaseId requires docId.');
          }
          let sources: { id: string; title: string; doc: YDoc }[] = [];
          let truncated = false;
          if (docId) {
            const doc = await loadReadableDoc(docId);
            if (!doc) return toolError(`Doc with id ${docId} not found.`);
            sources = [{ id: docId, title: '', doc }];
          } else {
            const scan = await readableWorkspaceDocs();
            truncated = scan.truncated;
            for (const page of scan.pages) {
              const aborted = abortIfNeeded(options.signal);
              if (aborted) return aborted;
              const doc = await loadYDoc(page.id);
              if (doc && listBoards(doc).length) {
                sources.push({ id: page.id, title: page.title, doc });
              }
            }
          }

          const ctx = await loadTicketContext(sources.map(({ doc }) => doc));
          const tickets = sources.flatMap(source =>
            listTickets(
              source.doc,
              { databaseId, user, project, type, parent, status, query },
              ctx
            ).map(ticket => ({
              docId: source.id,
              ...(source.title ? { docTitle: source.title } : {}),
              ...ticket,
            }))
          );
          const max = limit ?? DEFAULT_TICKET_LIMIT;
          return toolText(
            JSON.stringify({
              total: tickets.length,
              tickets: tickets.slice(0, max),
              ...(truncated ? { truncated } : {}),
            })
          );
        }),
    });

    const getTicketTool = defineTool({
      name: 'get_ticket',
      title: 'Get Ticket',
      description:
        "Get a ticket by key (e.g. SZ-12) or id: all fields, its parent and sub-tasks, its description (the linked doc's content, if any), and the board's columns and status options.",
      parser: z.object({
        docId: z.string().optional(),
        ticketId: z.string().trim().min(1),
      }),
      inputSchema: {
        type: 'object',
        properties: { docId: docIdProperty, ticketId: ticketIdProperty },
        required: ['ticketId'],
        additionalProperties: false,
      },
      execute: async ({ docId, ticketId }) =>
        runTicketTool(async () => {
          const found = await findTicketDoc(ticketId, docId, loadReadableDoc);
          if (!found) return ticketNotFound(ticketId, docId);
          const ctx = await loadTicketContext([found.doc]);
          const result = getTicket(found.doc, ticketId, ctx);

          let description: string | undefined;
          const linkedDocId = result.ticket.linkedDocId;
          if (
            linkedDocId &&
            (await this.ac
              .user(userId)
              .workspace(workspaceId)
              .doc(linkedDocId)
              .can('Doc.Read'))
          ) {
            description = (
              await this.reader.getDocMarkdown(workspaceId, linkedDocId, false)
            )?.markdown;
          }

          return toolText(
            JSON.stringify({
              docId: found.docId,
              ...result,
              ...(description !== undefined ? { description } : {}),
            })
          );
        }),
    });

    const tools = [
      readDocument,
      docSearch,
      listTicketBoards,
      listTicketsTool,
      getTicketTool,
    ];

    if (accessMode === McpAccessMode.READ_WRITE) {
      const loadWritableDoc = async (docId: string) => {
        const writable = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Update');
        return writable ? await loadYDoc(docId) : null;
      };

      const ticketResult = async (docId: string, doc: YDoc, ticketId: string) =>
        toolText(
          JSON.stringify({
            success: true,
            docId,
            ...getTicket(doc, ticketId, await loadTicketContext([doc])),
          })
        );

      const updateTicketStatus = defineTool({
        name: 'update_ticket_status',
        title: 'Update Ticket Status',
        description:
          "Move a ticket to another status. The status must be one of the board's status options (see list_ticket_boards).",
        parser: z.object({
          docId: z.string().optional(),
          ticketId: z.string().trim().min(1),
          status: z.string().min(1),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: docIdProperty,
            ticketId: ticketIdProperty,
            status: { type: 'string' },
          },
          required: ['ticketId', 'status'],
          additionalProperties: false,
        },
        execute: async ({ docId, ticketId, status }, options) =>
          runTicketTool(async () => {
            const found = await findTicketDoc(ticketId, docId, loadWritableDoc);
            if (!found) return ticketNotFound(ticketId, docId);
            const update = updateTicket(found.doc, ticketId, { status });
            const aborted = abortIfNeeded(options.signal);
            if (aborted) return aborted;
            await this.writer.applyUpdate(
              workspaceId,
              found.docId,
              update,
              userId
            );
            return await ticketResult(found.docId, found.doc, ticketId);
          }),
      });

      const updateTicketTool = defineTool({
        name: 'update_ticket',
        title: 'Update Ticket',
        description:
          'Update the title, status, parent and/or fields of a ticket. Fields are keyed by column name; set parent to a ticket key to make this a sub-task, or null to detach it.',
        parser: z.object({
          docId: z.string().optional(),
          ticketId: z.string().trim().min(1),
          title: z.string().trim().min(1).optional(),
          status: z.string().optional(),
          parent: z.string().trim().min(1).nullable().optional(),
          fields: z.record(z.string(), z.unknown()).optional(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: docIdProperty,
            ticketId: ticketIdProperty,
            title: { type: 'string' },
            status: { type: 'string' },
            parent: {
              type: ['string', 'null'],
              description: 'Key or id of the parent ticket, or null',
            },
            fields: ticketFieldsSchema,
          },
          required: ['ticketId'],
          additionalProperties: false,
        },
        execute: async (
          { docId, ticketId, title, status, parent, fields },
          options
        ) =>
          runTicketTool(async () => {
            const found = await findTicketDoc(ticketId, docId, loadWritableDoc);
            if (!found) return ticketNotFound(ticketId, docId);
            const ctx = await loadTicketContext([found.doc]);
            const cleanTitle = title?.replace(/[\r\n]+/g, ' ');

            // A ticket with a description doc takes its title from that doc.
            const linkedDocId = linkedDocOf(found.doc, ticketId);
            const update = updateTicket(
              found.doc,
              ticketId,
              {
                title: linkedDocId ? undefined : cleanTitle,
                status,
                parent,
                fields,
              },
              ctx
            );
            const aborted = abortIfNeeded(options.signal);
            if (aborted) return aborted;
            if (cleanTitle && linkedDocId) {
              await this.ac
                .user(userId)
                .workspace(workspaceId)
                .doc(linkedDocId)
                .assert('Doc.Update');
              await this.writer.updateDocMeta(
                workspaceId,
                linkedDocId,
                { title: cleanTitle },
                userId
              );
              docTitles?.set(linkedDocId, cleanTitle);
            }
            await this.writer.applyUpdate(
              workspaceId,
              found.docId,
              update,
              userId
            );
            return await ticketResult(found.docId, found.doc, ticketId);
          }),
      });

      const createTicketTool = defineTool({
        name: 'create_ticket',
        title: 'Create Ticket',
        description:
          'Create a ticket on a board. Boards with a Key column get the next key (e.g. SZ-13). Pass parent (a ticket key) to create a sub-task on the same board; then docId and databaseId can be omitted. A description is stored as a linked doc, like "create a linked doc" in AFFiNE.',
        parser: z.object({
          docId: z.string().optional(),
          databaseId: z.string().optional(),
          parent: z.string().trim().min(1).optional(),
          title: z.string().trim().min(1),
          status: z.string().optional(),
          description: z.string().max(100_000).optional(),
          fields: z.record(z.string(), z.unknown()).optional(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: docIdProperty,
            databaseId: {
              type: 'string',
              description: 'Board id from list_ticket_boards',
            },
            parent: {
              type: 'string',
              description: 'Key or id of the parent ticket for a sub-task',
            },
            title: { type: 'string' },
            status: { type: 'string' },
            description: {
              type: 'string',
              description: 'Markdown description',
            },
            fields: ticketFieldsSchema,
          },
          required: ['title'],
          additionalProperties: false,
        },
        execute: async (
          { docId, databaseId, parent, title, status, description, fields },
          options
        ) =>
          runTicketTool(async () => {
            if (!databaseId && !parent) {
              return toolError(
                'Pass databaseId (see list_ticket_boards), or parent to create a sub-task.'
              );
            }
            let found: { docId: string; doc: YDoc } | null;
            if (docId) {
              const doc = await loadWritableDoc(docId);
              if (!doc) return toolError(`Doc with id ${docId} not found.`);
              found = { docId, doc };
            } else if (parent) {
              // a sub-task goes on its parent's board
              found = await findTicketDoc(parent, undefined, loadWritableDoc);
              if (!found) return ticketNotFound(parent);
            } else {
              return toolError('docId is required with databaseId.');
            }
            const ctx = await loadTicketContext([found.doc]);
            const cleanTitle = title.replace(/[\r\n]+/g, ' ');
            const input = { title: cleanTitle, status, parent, fields };

            // validate before creating a description doc
            createTicket(
              loadDoc(encodeStateAsUpdate(found.doc)),
              databaseId,
              input,
              ctx
            );

            let linkedDocId: string | undefined;
            if (description?.trim()) {
              await this.ac
                .user(userId)
                .workspace(workspaceId)
                .assert('Workspace.CreateDoc');
              linkedDocId = (
                await this.writer.createDoc(
                  workspaceId,
                  cleanTitle,
                  description,
                  userId
                )
              ).docId;
              docTitles?.set(linkedDocId, cleanTitle);
            }
            const aborted = abortIfNeeded(options.signal);
            if (aborted) return aborted;
            const { ticketId, update } = createTicket(
              found.doc,
              databaseId,
              { ...input, linkedDocId },
              ctx
            );
            await this.writer.applyUpdate(
              workspaceId,
              found.docId,
              update,
              userId
            );
            return await ticketResult(found.docId, found.doc, ticketId);
          }),
      });

      tools.push(updateTicketStatus, updateTicketTool, createTicketTool);
    }

    if (accessMode === McpAccessMode.READ_WRITE && mcpWriteToolsAvailable()) {
      const createDocument = defineTool({
        name: 'create_document',
        title: 'Create Document',
        description:
          'Create a new document in the workspace with the given title and markdown content. Returns the ID of the created document. This tool not support insert or update database block and image yet.',
        parser: z.object({
          title: z.string().min(1),
          content: z.string(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'The title of the new document',
            },
            content: {
              type: 'string',
              description: 'The markdown content for the document body',
            },
          },
          required: ['title', 'content'],
          additionalProperties: false,
        },
        execute: async ({ title, content }, options) => {
          try {
            await this.ac
              .user(userId)
              .workspace(workspaceId)
              .assert('Workspace.CreateDoc');
            const abortedBeforeWrite = abortIfNeeded(options.signal);
            if (abortedBeforeWrite) return abortedBeforeWrite;

            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');
            const strippedContent = content.replace(
              /^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/,
              ''
            );
            const result = await this.writer.createDoc(
              workspaceId,
              sanitizedTitle,
              strippedContent,
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                docId: result.docId,
                message: `Document "${title}" created successfully`,
              })
            );
          } catch (error) {
            return toolError(
              `Failed to create document: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const updateDocument = defineTool({
        name: 'update_document',
        title: 'Update Document',
        description:
          'Update an existing document with new markdown content (body only). Uses structural diffing to apply minimal changes, preserving document history and enabling real-time collaboration. This does NOT update the document title. This tool not support insert or update database block and image yet.',
        parser: z.object({
          docId: z.string(),
          content: z.string(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            content: {
              type: 'string',
              description:
                'The complete new markdown content for the document body (do NOT include a title H1)',
            },
          },
          required: ['docId', 'content'],
          additionalProperties: false,
        },
        execute: async ({ docId, content }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);

          const canUpdate = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!canUpdate) return notFoundError;
          const abortedBeforeWrite = abortIfNeeded(options.signal);
          if (abortedBeforeWrite) return abortedBeforeWrite;

          try {
            await this.writer.updateDoc(workspaceId, docId, content, userId);
            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document updated successfully',
              })
            );
          } catch {
            return notFoundError;
          }
        },
      });

      const updateDocumentMeta = defineTool({
        name: 'update_document_meta',
        title: 'Update Document Metadata',
        description: 'Update document metadata (currently title only).',
        parser: z.object({
          docId: z.string(),
          title: z.string().min(1),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            title: {
              type: 'string',
              description: 'The new document title',
            },
          },
          required: ['docId', 'title'],
          additionalProperties: false,
        },
        execute: async ({ docId, title }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);
          const canUpdate = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!canUpdate) return notFoundError;
          const abortedBeforeWrite = abortIfNeeded(options.signal);
          if (abortedBeforeWrite) return abortedBeforeWrite;

          try {
            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');

            await this.writer.updateDocMeta(
              workspaceId,
              docId,
              { title: sanitizedTitle },
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document title updated successfully',
              })
            );
          } catch {
            return notFoundError;
          }
        },
      });

      tools.push(createDocument, updateDocument, updateDocumentMeta);
    }

    return {
      name: `AFFiNE MCP Server for Workspace ${workspaceId}`,
      version: '1.0.1',
      tools,
    };
  }
}
