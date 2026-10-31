import { nanoid } from 'nanoid';
import {
  applyUpdate,
  Array as YArray,
  Doc as YDoc,
  encodeStateAsUpdate,
  encodeStateVector,
  Map as YMap,
  Text as YText,
} from 'yjs';

/**
 * "Tickets" are rows of an AFFiNE database block (table / kanban view).
 *
 * Yjs layout of a database block (see blocksuite DatabaseBlockSchema):
 * - `prop:title`   Y.Text
 * - `prop:columns` Y.Array<Y.Map{ id, type, name, data: Y.Map{ options? } }>
 * - `prop:cells`   Y.Map<rowId, Y.Map<columnId, Y.Map{ columnId, value }>>
 * - `sys:children` Y.Array<rowId>, each row being an `affine:paragraph` block
 *   whose `prop:text` is the ticket title.
 *
 * People are stored as user ids: a `member` column holds an array of ids and a
 * `created-by` column a single id. A {@link TicketUsers} directory turns them
 * into names.
 */

export class TicketError extends Error {}

export interface TicketOption {
  id: string;
  value: string;
  color?: string;
}

export interface TicketColumn {
  id: string;
  name: string;
  type: string;
  options?: TicketOption[];
}

export interface TicketBoard {
  databaseId: string;
  title: string;
  columns: TicketColumn[];
  statusColumn: { id: string; name: string; options: string[] } | null;
  ticketCount: number;
}

export interface Ticket {
  id: string;
  databaseId: string;
  title: string;
  status: string | null;
  /** The "Project" column if the board has one, otherwise the board title. */
  project: string | null;
  /** People in the ticket's member columns (assignee, owner, …). */
  assignees: string[];
  createdBy: string | null;
  linkedDocId?: string;
  fields: Record<string, unknown>;
}

export interface TicketUser {
  id: string;
  name: string;
  email?: string;
}

/** Workspace users by id, used to show and match people by name or email. */
export type TicketUsers = Map<string, TicketUser>;

export interface TicketFilter {
  databaseId?: string;
  status?: string;
  query?: string;
  /** Name, email or id of someone in a member or created-by column. */
  user?: string;
  /** Matched against {@link Ticket.project}. */
  project?: string;
}

export interface WorkspacePage {
  id: string;
  title: string;
}

const DATABASE_FLAVOUR = 'affine:database';
const MEMBER_COLUMN = 'member';
const CREATED_BY_COLUMN = 'created-by';

export function loadDoc(bin: Uint8Array): YDoc {
  const doc = new YDoc();
  applyUpdate(doc, bin);
  return doc;
}

/**
 * Apply `mutate` to `doc` and return the Yjs update it produced.
 */
export function mutateDoc(doc: YDoc, mutate: () => void): Uint8Array {
  const before = encodeStateVector(doc);
  doc.transact(mutate);
  return encodeStateAsUpdate(doc, before);
}

/**
 * Pages listed in the workspace root doc, excluding trashed ones.
 */
export function listWorkspacePages(rootDoc: YDoc): WorkspacePage[] {
  const pages = rootDoc.getMap('meta').get('pages');
  if (!(pages instanceof YArray)) return [];
  const result: WorkspacePage[] = [];
  for (const page of pages) {
    if (!(page instanceof YMap)) continue;
    const id = page.get('id');
    if (typeof id !== 'string' || page.get('trash') === true) continue;
    const title = page.get('title');
    result.push({ id, title: typeof title === 'string' ? title : '' });
  }
  return result;
}

function blocks(doc: YDoc) {
  return doc.getMap<YMap<unknown>>('blocks');
}

function children(block: YMap<unknown>): string[] {
  const value = block.get('sys:children');
  return value instanceof YArray ? (value.toArray() as string[]) : [];
}

function databaseBlocks(doc: YDoc) {
  const result: YMap<unknown>[] = [];
  for (const block of blocks(doc).values()) {
    if (block.get('sys:flavour') === DATABASE_FLAVOUR) result.push(block);
  }
  return result;
}

function readColumns(database: YMap<unknown>): TicketColumn[] {
  const columns = database.get('prop:columns');
  if (!(columns instanceof YArray)) return [];
  return columns.toJSON().map((column: Record<string, any>) => {
    const result: TicketColumn = {
      id: column.id,
      name: column.name ?? '',
      type: column.type,
    };
    if (Array.isArray(column.data?.options)) {
      result.options = column.data.options.map((option: TicketOption) => ({
        id: option.id,
        value: option.value,
        color: option.color,
      }));
    }
    return result;
  });
}

function findStatusColumn(columns: TicketColumn[]) {
  const selects = columns.filter(column => column.type === 'select');
  return (
    selects.find(column => /^status$/i.test(column.name.trim())) ??
    selects.find(column => /status|state|stage/i.test(column.name)) ??
    selects[0] ??
    null
  );
}

function boardOf(database: YMap<unknown>): TicketBoard {
  const columns = readColumns(database);
  const status = findStatusColumn(columns);
  return {
    databaseId: database.get('sys:id') as string,
    title: database.get('prop:title')?.toString() ?? '',
    columns,
    statusColumn: status
      ? {
          id: status.id,
          name: status.name,
          options: (status.options ?? []).map(option => option.value),
        }
      : null,
    ticketCount: children(database).length,
  };
}

function getDatabase(doc: YDoc, databaseId: string) {
  const database = blocks(doc).get(databaseId);
  if (!database || database.get('sys:flavour') !== DATABASE_FLAVOUR) {
    throw new TicketError(`Ticket board ${databaseId} not found.`);
  }
  return database;
}

function rowCells(database: YMap<unknown>, rowId: string) {
  const cells = database.get('prop:cells');
  if (!(cells instanceof YMap)) return null;
  const row = cells.get(rowId);
  return row instanceof YMap ? row : null;
}

function cellValue(database: YMap<unknown>, rowId: string, columnId: string) {
  const cell = rowCells(database, rowId)?.get(columnId);
  return cell instanceof YMap ? cell.get('value') : undefined;
}

function optionLabel(column: TicketColumn, id: unknown) {
  return column.options?.find(option => option.id === id)?.value ?? null;
}

function isUserColumn(column: TicketColumn) {
  return column.type === MEMBER_COLUMN || column.type === CREATED_BY_COLUMN;
}

function userIdsOf(value: unknown): string[] {
  const ids = value instanceof YArray ? value.toArray() : value;
  if (typeof ids === 'string') return [ids];
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string')
    : [];
}

function userName(users: TicketUsers | undefined, id: string) {
  return users?.get(id)?.name || id;
}

function findProjectColumn(columns: TicketColumn[]) {
  return (
    columns.find(column => /^project$/i.test(column.name.trim())) ??
    columns.find(column => /project/i.test(column.name)) ??
    null
  );
}

function formatValue(
  column: TicketColumn,
  value: unknown,
  users?: TicketUsers
): unknown {
  if (value === undefined || value === null) return null;
  switch (column.type) {
    case MEMBER_COLUMN:
      return userIdsOf(value).map(id => userName(users, id));
    case CREATED_BY_COLUMN: {
      const [id] = userIdsOf(value);
      return id ? userName(users, id) : null;
    }
    case 'select':
      return optionLabel(column, value);
    case 'multi-select': {
      const ids = value instanceof YArray ? value.toArray() : value;
      return Array.isArray(ids)
        ? ids.map(id => optionLabel(column, id)).filter(Boolean)
        : [];
    }
    case 'date':
      return typeof value === 'number' ? new Date(value).toISOString() : null;
    default:
      if (value instanceof YText) return value.toString();
      if (value instanceof YMap || value instanceof YArray) {
        return value.toJSON();
      }
      return value;
  }
}

function linkedDocIdOf(text: unknown) {
  if (!(text instanceof YText)) return undefined;
  for (const op of text.toDelta() as { attributes?: any }[]) {
    const pageId = op.attributes?.reference?.pageId;
    if (typeof pageId === 'string') return pageId;
  }
  return undefined;
}

function projectOf(value: unknown, boardTitle: string) {
  const label = Array.isArray(value) ? value.join(', ') : value;
  return typeof label === 'string' && label.trim()
    ? label
    : boardTitle.trim() || null;
}

function ticketOf(
  doc: YDoc,
  database: YMap<unknown>,
  columns: TicketColumn[],
  rowId: string,
  users?: TicketUsers
): Ticket | null {
  const row = blocks(doc).get(rowId);
  if (!row) return null;
  const text = row.get('prop:text');
  const status = findStatusColumn(columns);
  const projectColumn = findProjectColumn(columns);
  const fields: Record<string, unknown> = {};
  const assignees: string[] = [];
  let createdBy: string | null = null;
  let project: unknown;
  for (const column of columns) {
    if (column.type === 'title') continue;
    const value = cellValue(database, rowId, column.id);
    const formatted = formatValue(column, value, users);
    fields[column.name || column.id] = formatted;
    if (column.type === MEMBER_COLUMN) {
      for (const name of formatted as string[]) {
        if (!assignees.includes(name)) assignees.push(name);
      }
    } else if (column.type === CREATED_BY_COLUMN && !createdBy) {
      createdBy = formatted as string | null;
    }
    if (column === projectColumn) project = formatted;
  }
  const ticket: Ticket = {
    id: rowId,
    databaseId: database.get('sys:id') as string,
    title: text?.toString() ?? '',
    status: status
      ? (optionLabel(status, cellValue(database, rowId, status.id)) ?? null)
      : null,
    project: projectOf(project, database.get('prop:title')?.toString() ?? ''),
    assignees,
    createdBy,
    fields,
  };
  const linkedDocId = linkedDocIdOf(text);
  if (linkedDocId) ticket.linkedDocId = linkedDocId;
  return ticket;
}

export function listBoards(doc: YDoc): TicketBoard[] {
  return databaseBlocks(doc).map(boardOf);
}

/**
 * User ids referenced by member and created-by columns, to load names for.
 */
export function collectUserIds(doc: YDoc): string[] {
  const ids = new Set<string>();
  for (const database of databaseBlocks(doc)) {
    const columns = readColumns(database).filter(isUserColumn);
    if (!columns.length) continue;
    for (const rowId of children(database)) {
      for (const column of columns) {
        for (const id of userIdsOf(cellValue(database, rowId, column.id))) {
          ids.add(id);
        }
      }
    }
  }
  return [...ids];
}

function matchesUser(
  users: TicketUsers | undefined,
  ids: string[],
  query: string
) {
  return ids.some(id => {
    if (id.toLowerCase() === query) return true;
    const user = users?.get(id);
    return (
      !!user &&
      (user.name.toLowerCase().includes(query) ||
        !!user.email?.toLowerCase().includes(query))
    );
  });
}

function ticketUserIds(
  database: YMap<unknown>,
  columns: TicketColumn[],
  rowId: string
) {
  return columns
    .filter(isUserColumn)
    .flatMap(column => userIdsOf(cellValue(database, rowId, column.id)));
}

export function listTickets(
  doc: YDoc,
  filter: TicketFilter = {},
  users?: TicketUsers
): Ticket[] {
  const databases = filter.databaseId
    ? [getDatabase(doc, filter.databaseId)]
    : databaseBlocks(doc);
  const status = filter.status?.trim().toLowerCase();
  const query = filter.query?.trim().toLowerCase();
  const user = filter.user?.trim().toLowerCase();
  const project = filter.project?.trim().toLowerCase();
  const result: Ticket[] = [];
  for (const database of databases) {
    const columns = readColumns(database);
    for (const rowId of children(database)) {
      if (
        user &&
        !matchesUser(users, ticketUserIds(database, columns, rowId), user)
      ) {
        continue;
      }
      const ticket = ticketOf(doc, database, columns, rowId, users);
      if (!ticket) continue;
      if (status && ticket.status?.toLowerCase() !== status) continue;
      if (project && !ticket.project?.toLowerCase().includes(project)) {
        continue;
      }
      if (
        query &&
        !ticket.title.toLowerCase().includes(query) &&
        !JSON.stringify(ticket.fields).toLowerCase().includes(query)
      ) {
        continue;
      }
      result.push(ticket);
    }
  }
  return result;
}

function findTicketDatabase(doc: YDoc, ticketId: string) {
  const database = databaseBlocks(doc).find(block =>
    children(block).includes(ticketId)
  );
  if (!database) throw new TicketError(`Ticket ${ticketId} not found.`);
  return database;
}

export function getTicket(doc: YDoc, ticketId: string, users?: TicketUsers) {
  const database = findTicketDatabase(doc, ticketId);
  const board = boardOf(database);
  const ticket = ticketOf(doc, database, board.columns, ticketId, users);
  if (!ticket) throw new TicketError(`Ticket ${ticketId} not found.`);
  return { board, ticket };
}

function resolveColumn(columns: TicketColumn[], key: string) {
  const normalized = key.trim().toLowerCase();
  const column =
    columns.find(column => column.id === key) ??
    columns.find(column => column.name.trim().toLowerCase() === normalized);
  if (!column) {
    throw new TicketError(
      `Unknown field "${key}". Available fields: ${columns
        .map(column => column.name || column.id)
        .join(', ')}.`
    );
  }
  return column;
}

function resolveOption(column: TicketColumn, input: unknown) {
  if (typeof input !== 'string') {
    throw new TicketError(`Field "${column.name}" expects an option name.`);
  }
  const normalized = input.trim().toLowerCase();
  const option =
    column.options?.find(option => option.id === input) ??
    column.options?.find(
      option => option.value.trim().toLowerCase() === normalized
    );
  if (!option) {
    throw new TicketError(
      `"${input}" is not a valid option for "${column.name}". Valid options: ${(
        column.options ?? []
      )
        .map(option => option.value)
        .join(', ')}.`
    );
  }
  return option.id;
}

function resolveUser(
  column: TicketColumn,
  users: TicketUsers | undefined,
  input: unknown
) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new TicketError(
      `Field "${column.name}" expects user names, emails or ids.`
    );
  }
  const query = input.trim().toLowerCase();
  const all = [...(users?.values() ?? [])];
  const exact = all.filter(
    user =>
      user.id === input.trim() ||
      user.email?.toLowerCase() === query ||
      user.name.toLowerCase() === query
  );
  const matches = exact.length
    ? exact
    : all.filter(
        user =>
          user.name.toLowerCase().includes(query) ||
          !!user.email?.toLowerCase().includes(query)
      );
  if (matches.length === 1) return matches[0].id;
  const known = all.map(user => user.name || user.email || user.id).join(', ');
  throw new TicketError(
    matches.length
      ? `"${input}" matches several users: ${matches
          .map(user => user.name || user.email)
          .join(', ')}. Use an email to pick one.`
      : `No workspace member matches "${input}". Members: ${known || 'none'}.`
  );
}

function toCellValue(
  column: TicketColumn,
  input: unknown,
  users?: TicketUsers
): unknown {
  switch (column.type) {
    case MEMBER_COLUMN: {
      const values = Array.isArray(input) ? input : [input];
      return YArray.from([
        ...new Set(values.map(value => resolveUser(column, users, value))),
      ]);
    }
    case 'select':
      return resolveOption(column, input);
    case 'multi-select': {
      const values = Array.isArray(input) ? input : [input];
      return YArray.from(values.map(value => resolveOption(column, value)));
    }
    case 'rich-text':
    case 'text':
      return new YText(String(input));
    case 'number':
    case 'progress': {
      const value = Number(input);
      if (!Number.isFinite(value)) {
        throw new TicketError(`Field "${column.name}" expects a number.`);
      }
      return column.type === 'progress'
        ? Math.min(100, Math.max(0, value))
        : value;
    }
    case 'checkbox':
      if (typeof input !== 'boolean') {
        throw new TicketError(`Field "${column.name}" expects true or false.`);
      }
      return input;
    case 'date': {
      const value =
        typeof input === 'number' ? input : Date.parse(String(input));
      if (!Number.isFinite(value)) {
        throw new TicketError(
          `Field "${column.name}" expects an ISO date or a timestamp.`
        );
      }
      return value;
    }
    default:
      throw new TicketError(
        `Field "${column.name}" of type "${column.type}" cannot be edited through MCP.`
      );
  }
}

function setRowTitle(doc: YDoc, rowId: string, title: string) {
  const text = blocks(doc).get(rowId)?.get('prop:text');
  if (!(text instanceof YText)) {
    throw new TicketError(`Ticket ${rowId} has no editable title.`);
  }
  text.delete(0, text.length);
  text.insert(0, title);
}

function writeFields(
  doc: YDoc,
  database: YMap<unknown>,
  rowId: string,
  fields: Record<string, unknown>,
  users?: TicketUsers
) {
  const columns = readColumns(database);
  // validate everything before touching the doc
  const writes = Object.entries(fields).map(([key, input]) => {
    const column = resolveColumn(columns, key);
    if (column.type === 'title') {
      return { column, title: String(input ?? '') };
    }
    return {
      column,
      value: input === null ? null : toCellValue(column, input, users),
    };
  });

  let cells = database.get('prop:cells');
  if (!(cells instanceof YMap)) {
    cells = new YMap();
    database.set('prop:cells', cells);
  }
  const cellMap = cells as YMap<YMap<unknown>>;

  for (const write of writes) {
    if ('title' in write) {
      setRowTitle(doc, rowId, write.title ?? '');
      continue;
    }
    let row = cellMap.get(rowId);
    if (!(row instanceof YMap)) {
      row = new YMap();
      cellMap.set(rowId, row);
    }
    if (write.value === null) {
      row.delete(write.column.id);
      continue;
    }
    const cell = new YMap<unknown>();
    cell.set('columnId', write.column.id);
    cell.set('value', write.value);
    row.set(write.column.id, cell);
  }
}

function statusField(database: YMap<unknown>, status: string) {
  const column = findStatusColumn(readColumns(database));
  if (!column) {
    throw new TicketError(
      'This ticket board has no select column to use as status.'
    );
  }
  return { [column.id]: status };
}

export function updateTicket(
  doc: YDoc,
  ticketId: string,
  changes: {
    title?: string;
    status?: string;
    fields?: Record<string, unknown>;
  },
  users?: TicketUsers
): Uint8Array {
  const database = findTicketDatabase(doc, ticketId);
  const fields: Record<string, unknown> = { ...changes.fields };
  if (changes.status !== undefined) {
    Object.assign(fields, statusField(database, changes.status));
  }
  return mutateDoc(doc, () => {
    if (changes.title !== undefined) setRowTitle(doc, ticketId, changes.title);
    writeFields(doc, database, ticketId, fields, users);
  });
}

export function createTicket(
  doc: YDoc,
  databaseId: string,
  input: { title: string; status?: string; fields?: Record<string, unknown> },
  users?: TicketUsers
): { ticketId: string; update: Uint8Array } {
  const database = getDatabase(doc, databaseId);
  const fields: Record<string, unknown> = { ...input.fields };
  if (input.status !== undefined) {
    Object.assign(fields, statusField(database, input.status));
  }
  const ticketId = nanoid(10);
  const update = mutateDoc(doc, () => {
    const row = new YMap<unknown>();
    blocks(doc).set(ticketId, row);
    row.set('sys:id', ticketId);
    row.set('sys:flavour', 'affine:paragraph');
    row.set('sys:version', 1);
    row.set('sys:children', new YArray());
    row.set('prop:type', 'text');
    row.set('prop:text', new YText(input.title));
    row.set('prop:collapsed', false);

    let rows = database.get('sys:children');
    if (!(rows instanceof YArray)) {
      rows = new YArray<string>();
      database.set('sys:children', rows);
    }
    (rows as YArray<string>).push([ticketId]);

    writeFields(doc, database, ticketId, fields, users);
  });
  return { ticketId, update };
}
