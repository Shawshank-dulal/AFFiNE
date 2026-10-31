import test from 'ava';
import {
  applyUpdate,
  Array as YArray,
  Doc as YDoc,
  encodeStateAsUpdate,
  Map as YMap,
  Text as YText,
} from 'yjs';

import {
  collectUserIds,
  createTicket,
  getTicket,
  linkedDocOf,
  listBoards,
  listTickets,
  listWorkspacePages,
  loadDoc,
  TicketError,
  type TicketUsers,
  updateTicket,
} from '../../plugins/copilot/mcp/tickets';

function block(
  doc: YDoc,
  id: string,
  flavour: string,
  props: Record<string, unknown>,
  children: string[] = []
) {
  const yblock = new YMap<unknown>();
  doc.getMap('blocks').set(id, yblock);
  yblock.set('sys:id', id);
  yblock.set('sys:flavour', flavour);
  yblock.set('sys:children', YArray.from(children));
  for (const [key, value] of Object.entries(props)) {
    yblock.set(`prop:${key}`, value);
  }
  return yblock;
}

function ymap(entries: Record<string, unknown>) {
  const map = new YMap<unknown>();
  for (const [key, value] of Object.entries(entries)) map.set(key, value);
  return map;
}

function cell(columnId: string, value: unknown) {
  return ymap({ columnId, value });
}

function createBoardDoc() {
  const doc = new YDoc();
  doc.transact(() => {
    block(doc, 'page', 'affine:page', { title: new YText('Sprint') }, ['note']);
    block(doc, 'note', 'affine:note', {}, ['db']);
    block(doc, 'row-1', 'affine:paragraph', {
      type: 'text',
      text: new YText('Fix login bug'),
    });
    block(doc, 'row-2', 'affine:paragraph', {
      type: 'text',
      text: new YText('Write docs'),
    });
    block(
      doc,
      'db',
      'affine:database',
      {
        title: new YText('Tickets'),
        columns: YArray.from([
          ymap({ id: 'c-title', type: 'title', name: 'Title', data: ymap({}) }),
          ymap({
            id: 'c-status',
            type: 'select',
            name: 'Status',
            data: ymap({
              options: YArray.from([
                ymap({ id: 'o-todo', value: 'Todo', color: 'grey' }),
                ymap({ id: 'o-doing', value: 'In Progress', color: 'blue' }),
                ymap({ id: 'o-done', value: 'Done', color: 'green' }),
              ]),
            }),
          }),
          ymap({
            id: 'c-points',
            type: 'number',
            name: 'Points',
            data: ymap({}),
          }),
          ymap({
            id: 'c-notes',
            type: 'rich-text',
            name: 'Notes',
            data: ymap({}),
          }),
        ]),
        cells: ymap({
          'row-1': ymap({
            'c-status': cell('c-status', 'o-doing'),
            'c-points': cell('c-points', 3),
          }),
        }),
      },
      ['row-1', 'row-2']
    );
  });
  return doc;
}

function roundTrip(doc: YDoc) {
  return loadDoc(encodeStateAsUpdate(doc));
}

test('should list ticket boards with status column', t => {
  const [board] = listBoards(createBoardDoc());

  t.like(board, {
    databaseId: 'db',
    title: 'Tickets',
    ticketCount: 2,
    statusColumn: {
      id: 'c-status',
      name: 'Status',
      options: ['Todo', 'In Progress', 'Done'],
    },
  });
  t.deepEqual(
    board.columns.map(column => column.type),
    ['title', 'select', 'number', 'rich-text']
  );
});

test('should list and filter tickets', t => {
  const doc = createBoardDoc();

  const tickets = listTickets(doc);
  t.deepEqual(
    tickets.map(ticket => [ticket.id, ticket.title, ticket.status]),
    [
      ['row-1', 'Fix login bug', 'In Progress'],
      ['row-2', 'Write docs', null],
    ]
  );
  t.deepEqual(tickets[0].fields, {
    Status: 'In Progress',
    Points: 3,
    Notes: null,
  });

  t.deepEqual(
    listTickets(doc, { status: 'in progress' }).map(ticket => ticket.id),
    ['row-1']
  );
  t.deepEqual(
    listTickets(doc, { query: 'docs' }).map(ticket => ticket.id),
    ['row-2']
  );
  t.throws(() => listTickets(doc, { databaseId: 'missing' }), {
    instanceOf: TicketError,
  });
});

test('should update ticket status and fields with a mergeable update', t => {
  const doc = createBoardDoc();
  const remote = roundTrip(doc);

  const update = updateTicket(doc, 'row-2', {
    status: 'done',
    fields: { points: 5, Notes: 'shipped', Title: 'Write the docs' },
  });

  // the update alone brings another replica to the same state
  applyUpdate(remote, update);
  const { ticket } = getTicket(remote, 'row-2');
  t.like(ticket, {
    title: 'Write the docs',
    status: 'Done',
    fields: { Status: 'Done', Points: 5, Notes: 'shipped' },
  });
});

test('should reject invalid ticket changes without mutating the doc', t => {
  const doc = createBoardDoc();
  const before = encodeStateAsUpdate(doc);

  t.throws(() => updateTicket(doc, 'row-1', { status: 'Blocked' }), {
    instanceOf: TicketError,
    message: /Valid options: Todo, In Progress, Done/,
  });
  t.throws(() => updateTicket(doc, 'row-1', { fields: { Owner: 'me' } }), {
    instanceOf: TicketError,
    message: /Unknown field "Owner"/,
  });
  t.throws(() => updateTicket(doc, 'nope', { status: 'Done' }), {
    instanceOf: TicketError,
  });
  t.deepEqual(encodeStateAsUpdate(doc), before);
});

test('should clear a ticket field with null', t => {
  const doc = createBoardDoc();
  updateTicket(doc, 'row-1', { fields: { Status: null } });
  t.is(getTicket(doc, 'row-1').ticket.status, null);
});

test('should create a ticket as a database row', t => {
  const doc = createBoardDoc();
  const remote = roundTrip(doc);

  const { ticketId, update } = createTicket(doc, 'db', {
    title: 'New ticket',
    status: 'Todo',
    fields: { Points: 1 },
  });
  applyUpdate(remote, update);

  const row = remote.getMap<YMap<unknown>>('blocks').get(ticketId)!;
  t.is(row.get('sys:flavour'), 'affine:paragraph');
  t.is(row.get('prop:type'), 'text');
  t.like(getTicket(remote, ticketId).ticket, {
    title: 'New ticket',
    status: 'Todo',
    fields: { Points: 1 },
  });
  t.is(listBoards(remote)[0].ticketCount, 3);
});

test('should list non-trashed workspace pages', t => {
  const root = new YDoc();
  root
    .getMap('meta')
    .set(
      'pages',
      YArray.from([
        ymap({ id: 'a', title: 'Sprint' }),
        ymap({ id: 'b', title: 'Old', trash: true }),
      ])
    );

  t.deepEqual(listWorkspacePages(root), [{ id: 'a', title: 'Sprint' }]);
});

const users: TicketUsers = new Map([
  [
    'u-alice',
    { id: 'u-alice', name: 'Alice Smith', email: 'alice@stagezero.tech' },
  ],
  ['u-bob', { id: 'u-bob', name: 'Bob Jones', email: 'bob@stagezero.tech' }],
  [
    'u-bobby',
    { id: 'u-bobby', name: 'Bobby Tables', email: 'bobby@example.com' },
  ],
]);

function addPeopleColumns(doc: YDoc, withProject: boolean) {
  const db = doc.getMap<YMap<any>>('blocks').get('db')!;
  doc.transact(() => {
    const columns = db.get('prop:columns') as YArray<YMap<unknown>>;
    columns.push([
      ymap({
        id: 'c-assignee',
        type: 'member',
        name: 'Assignee',
        data: ymap({}),
      }),
      ymap({
        id: 'c-creator',
        type: 'created-by',
        name: 'Created By',
        data: ymap({}),
      }),
    ]);
    const cells = db.get('prop:cells') as YMap<YMap<unknown>>;
    cells
      .get('row-1')!
      .set('c-assignee', cell('c-assignee', YArray.from(['u-alice', 'u-bob'])));
    cells.get('row-1')!.set('c-creator', cell('c-creator', 'u-bob'));
    cells.set(
      'row-2',
      ymap({
        'c-assignee': cell('c-assignee', YArray.from(['u-gone'])),
        'c-creator': cell('c-creator', 'u-alice'),
      })
    );
    if (withProject) {
      columns.push([
        ymap({
          id: 'c-project',
          type: 'select',
          name: 'Project',
          data: ymap({
            options: YArray.from([
              ymap({ id: 'p-web', value: 'Website', color: 'red' }),
              ymap({ id: 'p-app', value: 'Mobile App', color: 'blue' }),
            ]),
          }),
        }),
      ]);
      cells.get('row-1')!.set('c-project', cell('c-project', 'p-web'));
      cells.get('row-2')!.set('c-project', cell('c-project', 'p-app'));
    }
  });
  return doc;
}

test('should show and filter tickets by user name, email or creator', t => {
  const doc = addPeopleColumns(createBoardDoc(), false);

  t.deepEqual(collectUserIds(doc).sort(), ['u-alice', 'u-bob', 'u-gone']);
  t.like(listTickets(doc, {}, { users })[0], {
    assignees: ['Alice Smith', 'Bob Jones'],
    createdBy: 'Bob Jones',
    fields: {
      Assignee: ['Alice Smith', 'Bob Jones'],
      'Created By': 'Bob Jones',
    },
  });
  // unknown users fall back to their id
  t.like(listTickets(doc, {}, { users })[1], { assignees: ['u-gone'] });

  const ids = (filter: Parameters<typeof listTickets>[1]) =>
    listTickets(doc, filter, { users }).map(ticket => ticket.id);
  t.deepEqual(ids({ user: 'alice' }), ['row-1', 'row-2']);
  t.deepEqual(ids({ user: 'BOB@stagezero.tech' }), ['row-1']);
  t.deepEqual(ids({ user: 'u-gone' }), ['row-2']);
  t.deepEqual(ids({ user: 'carol' }), []);
  t.deepEqual(ids({ user: 'alice', status: 'in progress' }), ['row-1']);
});

test('should filter tickets by project column or board title', t => {
  const withColumn = addPeopleColumns(createBoardDoc(), true);
  t.deepEqual(
    listTickets(withColumn, { project: 'mobile' }, { users }).map(ticket => [
      ticket.id,
      ticket.project,
    ]),
    [['row-2', 'Mobile App']]
  );

  // without a Project column the board is the project
  const withoutColumn = createBoardDoc();
  t.is(listTickets(withoutColumn)[0].project, 'Tickets');
  t.is(listTickets(withoutColumn, { project: 'tick' }).length, 2);
  t.is(listTickets(withoutColumn, { project: 'website' }).length, 0);
});

test('should assign tickets to members by name or email', t => {
  const doc = addPeopleColumns(createBoardDoc(), false);
  const remote = roundTrip(doc);

  applyUpdate(
    remote,
    updateTicket(
      doc,
      'row-2',
      { fields: { assignee: ['alice smith', 'bobby@example.com'] } },
      { users }
    )
  );
  t.deepEqual(getTicket(remote, 'row-2', { users }).ticket.assignees, [
    'Alice Smith',
    'Bobby Tables',
  ]);

  const { ticketId, update } = createTicket(
    doc,
    'db',
    { title: 'Assigned', fields: { Assignee: 'Bob Jones' } },
    { users }
  );
  applyUpdate(remote, update);
  t.deepEqual(getTicket(remote, ticketId, { users }).ticket.assignees, [
    'Bob Jones',
  ]);

  t.throws(
    () =>
      updateTicket(doc, 'row-1', { fields: { Assignee: 'bob' } }, { users }),
    { instanceOf: TicketError, message: /matches several users/ }
  );
  t.throws(
    () =>
      updateTicket(doc, 'row-1', { fields: { Assignee: 'carol' } }, { users }),
    { instanceOf: TicketError, message: /No workspace member matches "carol"/ }
  );
  t.throws(
    () =>
      updateTicket(
        doc,
        'row-1',
        { fields: { 'Created By': 'Bob Jones' } },
        { users }
      ),
    { instanceOf: TicketError, message: /cannot be edited/ }
  );
});

function jiraBoardDoc() {
  const doc = new YDoc();
  const types = YArray.from([
    ymap({ id: 't-epic', value: 'Epic', color: 'purple' }),
    ymap({ id: 't-story', value: 'Story', color: 'green' }),
    ymap({ id: 't-sub', value: 'Sub-task', color: 'teal' }),
  ]);
  const statuses = YArray.from([
    ymap({ id: 's-todo', value: 'To Do', color: 'gray' }),
    ymap({ id: 's-done', value: 'Done', color: 'green' }),
  ]);
  const rows: [string, string, string, string, string | null][] = [
    ['r1', 'Epic one', 'SZ-1', 't-epic', null],
    ['r2', 'Story one', 'SZ-2', 't-story', 'SZ-1'],
    ['r3', 'Sub-task A', 'SZ-3', 't-sub', 'SZ-2'],
    ['r4', 'Sub-task B', 'SZ-4', 't-sub', 'SZ-2'],
  ];
  doc.transact(() => {
    for (const [id, title] of rows) {
      block(doc, id, 'affine:paragraph', {
        type: 'text',
        text: new YText(title),
      });
    }
    const cells = ymap({});
    for (const [id, , key, type, parent] of rows) {
      const row = ymap({
        'c-key': cell('c-key', new YText(key)),
        'c-type': cell('c-type', type),
        'c-status': cell('c-status', 's-todo'),
      });
      if (parent) row.set('c-parent', cell('c-parent', new YText(parent)));
      cells.set(id, row);
    }
    block(
      doc,
      'db',
      'affine:database',
      {
        title: new YText('SZ'),
        columns: YArray.from([
          ymap({
            id: 'c-title',
            type: 'title',
            name: 'Summary',
            data: ymap({}),
          }),
          ymap({ id: 'c-key', type: 'rich-text', name: 'Key', data: ymap({}) }),
          ymap({
            id: 'c-type',
            type: 'select',
            name: 'Type',
            data: ymap({ options: types }),
          }),
          ymap({
            id: 'c-status',
            type: 'select',
            name: 'Status',
            data: ymap({ options: statuses }),
          }),
          ymap({
            id: 'c-parent',
            type: 'rich-text',
            name: 'Parent',
            data: ymap({}),
          }),
        ]),
        cells,
      },
      rows.map(([id]) => id)
    );
  });
  return doc;
}

test('should look up tickets by key with parent and sub-tasks', t => {
  const doc = jiraBoardDoc();

  const story = getTicket(doc, 'sz-2');
  t.like(story.ticket, {
    id: 'r2',
    key: 'SZ-2',
    type: 'Story',
    parent: 'SZ-1',
  });
  t.like(story.parentTicket, { key: 'SZ-1', title: 'Epic one', type: 'Epic' });
  t.deepEqual(
    story.subtasks.map(task => task.key),
    ['SZ-3', 'SZ-4']
  );
  t.deepEqual(getTicket(doc, 'r3').subtasks, []);
  t.throws(() => getTicket(doc, 'SZ-99'), { instanceOf: TicketError });

  const keys = (filter: Parameters<typeof listTickets>[1]) =>
    listTickets(doc, filter).map(ticket => ticket.key);
  t.deepEqual(keys({ parent: 'SZ-2' }), ['SZ-3', 'SZ-4']);
  t.deepEqual(keys({ parent: 'r1' }), ['SZ-2']);
  t.deepEqual(keys({ type: 'sub-task' }), ['SZ-3', 'SZ-4']);
});

test('should create sub-tasks with the next key', t => {
  const doc = jiraBoardDoc();
  const remote = roundTrip(doc);

  const { ticketId, update } = createTicket(doc, undefined, {
    title: 'Sub-task C',
    parent: 'SZ-2',
    fields: { Type: 'Sub-task' },
  });
  applyUpdate(remote, update);
  t.like(getTicket(remote, ticketId).ticket, {
    key: 'SZ-5',
    parent: 'SZ-2',
    type: 'Sub-task',
  });
  t.deepEqual(
    getTicket(remote, 'SZ-2').subtasks.map(task => task.key),
    ['SZ-3', 'SZ-4', 'SZ-5']
  );

  // re-parent and detach
  applyUpdate(remote, updateTicket(doc, 'SZ-5', { parent: 'SZ-1' }));
  t.is(getTicket(remote, 'SZ-5').ticket.parent, 'SZ-1');
  applyUpdate(remote, updateTicket(doc, 'SZ-5', { parent: null }));
  t.is(getTicket(remote, 'SZ-5').ticket.parent, null);
  t.throws(() => updateTicket(doc, 'SZ-5', { parent: 'SZ-5' }), {
    message: /own parent/,
  });
  t.throws(() => createTicket(doc, undefined, { title: 'x' }), {
    instanceOf: TicketError,
  });
});

test('should take titles from linked docs and keep the link', t => {
  const doc = jiraBoardDoc();
  const text = doc
    .getMap<YMap<any>>('blocks')
    .get('r2')!
    .get('prop:text') as YText;
  doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, ' ', { reference: { type: 'LinkedPage', pageId: 'doc-2' } });
  });

  const docTitles = new Map([['doc-2', 'Story one (with description)']]);
  t.like(getTicket(doc, 'SZ-2', { docTitles }).ticket, {
    title: 'Story one (with description)',
    linkedDocId: 'doc-2',
  });
  t.is(linkedDocOf(doc, 'SZ-2'), 'doc-2');
  t.is(linkedDocOf(doc, 'SZ-3'), undefined);
  t.throws(() => updateTicket(doc, 'SZ-2', { title: 'Renamed' }), {
    message: /linked doc/,
  });

  const created = createTicket(doc, 'db', {
    title: 'With description',
    linkedDocId: 'doc-9',
  });
  t.is(linkedDocOf(doc, created.ticketId), 'doc-9');
  t.like(
    getTicket(doc, created.ticketId, {
      docTitles: new Map([['doc-9', 'With description']]),
    }).ticket,
    { title: 'With description', key: 'SZ-5' }
  );
});
