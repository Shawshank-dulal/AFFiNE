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
 *
 * Jira-style boards are recognised by column name: `Key` (SZ-1), `Type`
 * (Epic, Story, Sub-task, …) and `Parent` (the parent ticket's key). A row
 * whose title links a doc ("create a linked doc" in AFFiNE) keeps its title
 * and description in that doc.
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
  /** The "Key" column, e.g. SZ-12. */
  key: string | null;
  /** The "Type" column, e.g. Story or Sub-task. */
  type: string | null;
  /** Key of the parent ticket, from the "Parent" column. */
  parent: string | null;
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

export interface TicketContext {
  users?: TicketUsers;
  /** Doc titles by id, for tickets whose title links a doc. */
  docTitles?: Map<string, string>;
}

export interface TicketSummary {
  id: string;
  key: string | null;
  title: string;
  type: string | null;
  status: string | null;
  assignees: string[];
}

export interface TicketFilter {
  databaseId?: string;
  status?: string;
  query?: string;
  /** Name, email or id of someone in a member or created-by column. */
  user?: string;
  /** Matched against {@link Ticket.project}. */
  project?: string;
  /** Ticket type, e.g. Bug. */
  type?: string;
  /** Key or id of the parent ticket: lists its sub-tasks / children. */
  parent?: string;
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

function findNamedColumn(
  columns: TicketColumn[],
  exact: RegExp,
  loose?: RegExp,
  types?: string[]
) {
  const candidates = types
    ? columns.filter(column => types.includes(column.type))
    : columns;
  return (
    candidates.find(column => exact.test(column.name.trim())) ??
    (loose ? candidates.find(column => loose.test(column.name)) : undefined) ??
    null
  );
}

const TEXT_TYPES = ['rich-text', 'text'];

function findKeyColumn(columns: TicketColumn[]) {
  return findNamedColumn(
    columns,
    /^(key|id|issue key|ticket key)$/i,
    undefined,
    TEXT_TYPES
  );
}

function findTypeColumn(columns: TicketColumn[]) {
  return findNamedColumn(
    columns,
    /^(type|issue type|ticket type)$/i,
    undefined,
    ['select']
  );
}

function findParentColumn(columns: TicketColumn[]) {
  return findNamedColumn(
    columns,
    /^(parent|parent key|epic|epic link)$/i,
    /parent/i,
    TEXT_TYPES
  );
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

function textValue(value: unknown) {
  if (value instanceof YText) return value.toString().trim() || null;
  return typeof value === 'string' ? value.trim() || null : null;
}

function ticketOf(
  doc: YDoc,
  database: YMap<unknown>,
  columns: TicketColumn[],
  rowId: string,
  ctx: TicketContext = {}
): Ticket | null {
  const { users } = ctx;
  const row = blocks(doc).get(rowId);
  if (!row) return null;
  const text = row.get('prop:text');
  const status = findStatusColumn(columns);
  const projectColumn = findProjectColumn(columns);
  const keyColumn = findKeyColumn(columns);
  const typeColumn = findTypeColumn(columns);
  const parentColumn = findParentColumn(columns);
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
  const linkedDocId = linkedDocIdOf(text);
  const rowTitle = text?.toString().trim() ?? '';
  const ticket: Ticket = {
    id: rowId,
    databaseId: database.get('sys:id') as string,
    title: (linkedDocId && ctx.docTitles?.get(linkedDocId)) || rowTitle || '',
    key: keyColumn ? textValue(cellValue(database, rowId, keyColumn.id)) : null,
    type: typeColumn
      ? optionLabel(typeColumn, cellValue(database, rowId, typeColumn.id))
      : null,
    parent: parentColumn
      ? textValue(cellValue(database, rowId, parentColumn.id))
      : null,
    status: status
      ? (optionLabel(status, cellValue(database, rowId, status.id)) ?? null)
      : null,
    project: projectOf(project, database.get('prop:title')?.toString() ?? ''),
    assignees,
    createdBy,
    fields,
  };
  if (linkedDocId) ticket.linkedDocId = linkedDocId;
  return ticket;
}

function summaryOf(ticket: Ticket): TicketSummary {
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    type: ticket.type,
    status: ticket.status,
    assignees: ticket.assignees,
  };
}

function boardTickets(doc: YDoc, database: YMap<unknown>, ctx: TicketContext) {
  const columns = readColumns(database);
  return children(database)
    .map(rowId => ticketOf(doc, database, columns, rowId, ctx))
    .filter((ticket): ticket is Ticket => !!ticket);
}

function sameKey(a: string | null | undefined, b: string | null | undefined) {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
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
  ctx: TicketContext = {}
): Ticket[] {
  const { users } = ctx;
  const databases = filter.databaseId
    ? [getDatabase(doc, filter.databaseId)]
    : databaseBlocks(doc);
  const status = filter.status?.trim().toLowerCase();
  const query = filter.query?.trim().toLowerCase();
  const user = filter.user?.trim().toLowerCase();
  const project = filter.project?.trim().toLowerCase();
  const type = filter.type?.trim().toLowerCase();
  const result: Ticket[] = [];
  for (const database of databases) {
    const columns = readColumns(database);
    // the parent filter takes a key or a row id
    const parentKey = filter.parent
      ? (ticketOf(doc, database, columns, filter.parent, ctx)?.key ??
        filter.parent)
      : undefined;
    for (const rowId of children(database)) {
      if (
        user &&
        !matchesUser(users, ticketUserIds(database, columns, rowId), user)
      ) {
        continue;
      }
      const ticket = ticketOf(doc, database, columns, rowId, ctx);
      if (!ticket) continue;
      if (status && ticket.status?.toLowerCase() !== status) continue;
      if (type && ticket.type?.toLowerCase() !== type) continue;
      if (parentKey && !sameKey(ticket.parent, parentKey)) continue;
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

/**
 * Finds a ticket by row id or by its Key (e.g. SZ-12).
 */
function findTicket(doc: YDoc, idOrKey: string) {
  for (const database of databaseBlocks(doc)) {
    const rows = children(database);
    if (rows.includes(idOrKey)) return { database, rowId: idOrKey };
    const keyColumn = findKeyColumn(readColumns(database));
    if (!keyColumn) continue;
    const rowId = rows.find(row =>
      sameKey(textValue(cellValue(database, row, keyColumn.id)), idOrKey)
    );
    if (rowId) return { database, rowId };
  }
  throw new TicketError(`Ticket ${idOrKey} not found.`);
}

export function hasTicket(doc: YDoc, idOrKey: string) {
  try {
    findTicket(doc, idOrKey);
    return true;
  } catch (error) {
    if (error instanceof TicketError) return false;
    throw error;
  }
}

/** Resolves a ticket id or key to the row id. */
export function resolveTicketId(doc: YDoc, idOrKey: string) {
  return findTicket(doc, idOrKey).rowId;
}

/** The doc a ticket's title links to, if it has a description doc. */
export function linkedDocOf(doc: YDoc, idOrKey: string) {
  const { rowId } = findTicket(doc, idOrKey);
  return linkedDocIdOf(blocks(doc).get(rowId)?.get('prop:text'));
}

export function getTicket(doc: YDoc, idOrKey: string, ctx: TicketContext = {}) {
  const { database, rowId } = findTicket(doc, idOrKey);
  const board = boardOf(database);
  const ticket = ticketOf(doc, database, board.columns, rowId, ctx);
  if (!ticket) throw new TicketError(`Ticket ${idOrKey} not found.`);
  const siblings = boardTickets(doc, database, ctx);
  const parent = ticket.parent
    ? siblings.find(other => sameKey(other.key, ticket.parent))
    : undefined;
  const subtasks = ticket.key
    ? siblings.filter(other => sameKey(other.parent, ticket.key))
    : [];
  return {
    board,
    ticket,
    parentTicket: parent ? summaryOf(parent) : null,
    subtasks: subtasks.map(summaryOf),
  };
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

/**
 * A row's title, optionally as a link to its description doc the way AFFiNE's
 * "create a linked doc" stores it (blocksuite database note-renderer).
 */
function ticketTitleText(title: string, linkedDocId?: string) {
  const text = new YText();
  if (linkedDocId) {
    text.insert(0, ' ', {
      reference: { type: 'LinkedPage', pageId: linkedDocId },
    });
  } else {
    text.insert(0, title);
  }
  return text;
}

function setRowTitle(doc: YDoc, rowId: string, title: string) {
  const text = blocks(doc).get(rowId)?.get('prop:text');
  if (!(text instanceof YText)) {
    throw new TicketError(`Ticket ${rowId} has no editable title.`);
  }
  if (linkedDocIdOf(text)) {
    // replacing the text would drop the link to the description doc
    throw new TicketError(
      `Ticket ${rowId} takes its title from a linked doc; rename that doc instead.`
    );
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

function isKeyField(database: YMap<unknown>, name: string) {
  const column = findKeyColumn(readColumns(database));
  return (
    !!column &&
    (name === column.id ||
      name.trim().toLowerCase() === column.name.trim().toLowerCase())
  );
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

function parentField(
  doc: YDoc,
  database: YMap<unknown>,
  parent: string | null,
  ctx: TicketContext
) {
  const column = findParentColumn(readColumns(database));
  if (!column) {
    throw new TicketError('This ticket board has no Parent column.');
  }
  if (parent === null) return { [column.id]: null };
  const parentTicket = getTicket(doc, parent, ctx).ticket;
  if (parentTicket.databaseId !== database.get('sys:id')) {
    throw new TicketError(`Ticket ${parent} is on another board.`);
  }
  if (!parentTicket.key) {
    throw new TicketError(`Ticket ${parent} has no Key to reference.`);
  }
  return { [column.id]: parentTicket.key };
}

/**
 * Next key for a board whose tickets are keyed like SZ-12: the most common
 * prefix and one past the highest number.
 */
function nextKey(doc: YDoc, database: YMap<unknown>) {
  const column = findKeyColumn(readColumns(database));
  if (!column) return null;
  const prefixes = new Map<string, number>();
  let max = 0;
  for (const rowId of children(database)) {
    const match = textValue(cellValue(database, rowId, column.id))?.match(
      /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/
    );
    if (!match) continue;
    const prefix = match[1].toUpperCase();
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    max = Math.max(max, Number(match[2]));
  }
  if (!prefixes.size) return null;
  const [prefix] = [...prefixes].sort((a, b) => b[1] - a[1])[0];
  return { columnId: column.id, key: `${prefix}-${max + 1}` };
}

export function updateTicket(
  doc: YDoc,
  idOrKey: string,
  changes: {
    title?: string;
    status?: string;
    parent?: string | null;
    fields?: Record<string, unknown>;
  },
  ctx: TicketContext = {}
): Uint8Array {
  const { database, rowId } = findTicket(doc, idOrKey);
  const fields: Record<string, unknown> = { ...changes.fields };
  if (changes.status !== undefined) {
    Object.assign(fields, statusField(database, changes.status));
  }
  if (changes.parent !== undefined) {
    if (
      changes.parent !== null &&
      resolveTicketId(doc, changes.parent) === rowId
    ) {
      throw new TicketError('A ticket cannot be its own parent.');
    }
    Object.assign(fields, parentField(doc, database, changes.parent, ctx));
  }
  return mutateDoc(doc, () => {
    if (changes.title !== undefined) setRowTitle(doc, rowId, changes.title);
    writeFields(doc, database, rowId, fields, ctx.users);
  });
}

export function createTicket(
  doc: YDoc,
  databaseId: string | undefined,
  input: {
    title: string;
    status?: string;
    /** Key or id of the parent ticket; also selects its board. */
    parent?: string;
    /** Doc holding the ticket's title and description. */
    linkedDocId?: string;
    fields?: Record<string, unknown>;
  },
  ctx: TicketContext = {}
): { ticketId: string; update: Uint8Array } {
  const database = databaseId
    ? getDatabase(doc, databaseId)
    : input.parent
      ? findTicket(doc, input.parent).database
      : null;
  if (!database) {
    throw new TicketError('Pass databaseId, or parent to create a sub-task.');
  }
  const fields: Record<string, unknown> = { ...input.fields };
  if (input.status !== undefined) {
    Object.assign(fields, statusField(database, input.status));
  }
  if (input.parent !== undefined) {
    Object.assign(fields, parentField(doc, database, input.parent, ctx));
  }
  const key = nextKey(doc, database);
  if (key && !Object.keys(fields).some(name => isKeyField(database, name))) {
    fields[key.columnId] = key.key;
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
    row.set('prop:text', ticketTitleText(input.title, input.linkedDocId));
    row.set('prop:collapsed', false);

    let rows = database.get('sys:children');
    if (!(rows instanceof YArray)) {
      rows = new YArray<string>();
      database.set('sys:children', rows);
    }
    (rows as YArray<string>).push([ticketId]);

    writeFields(doc, database, ticketId, fields, ctx.users);
  });
  return { ticketId, update };
}
