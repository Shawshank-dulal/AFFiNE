"""Builds an AFFiNE page snapshot (.zip) with a Jira-style ticket board.

Import it in AFFiNE with Import -> Snapshot.

Usage: python3 make-jira-board.py OUTPUT.zip [ASSIGNEE_USER_ID] [KEY] [PROJECT]
  ASSIGNEE_USER_ID  user id to set as assignee/reporter on the sample tickets
  KEY               ticket key prefix, default SZ
  PROJECT           project name, default "Stagezero Workspace"
"""
import json
import random
import string
import sys
import time
import zipfile

OUT = sys.argv[1]
ME = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
PROJECT_KEY = sys.argv[3] if len(sys.argv) > 3 else 'SZ'
PROJECT_NAME = sys.argv[4] if len(sys.argv) > 4 else 'Stagezero Workspace'
rand = random.Random(42)


def nid(n=21):
    return ''.join(rand.choice(string.ascii_letters + string.digits + '_-') for _ in range(n))


def text(s):
    return {'$blocksuite:internal:text$': True, 'delta': [{'insert': s}] if s else []}


def option(value, color):
    return {'id': nid(10), 'value': value, 'color': f'var(--affine-tag-{color})'}


def col(name, type_, data=None):
    return {'id': nid(), 'type': type_, 'name': name, 'data': data or {}}


def para(s, type_='text'):
    return {'type': 'block', 'id': nid(), 'flavour': 'affine:paragraph', 'version': 1,
            'props': {'type': type_, 'text': text(s), 'collapsed': False}, 'children': []}


types = [option(*o) for o in [('Epic', 'purple'), ('Story', 'green'), ('Task', 'blue'), ('Bug', 'red'), ('Sub-task', 'teal')]]
statuses = [option(*o) for o in [('To Do', 'gray'), ('In Progress', 'blue'), ('In Review', 'yellow'), ('Done', 'green')]]
priorities = [option(*o) for o in [('Highest', 'red'), ('High', 'orange'), ('Medium', 'yellow'), ('Low', 'blue'), ('Lowest', 'gray')]]
sprints = [option(*o) for o in [('Sprint 1', 'green'), ('Sprint 2', 'blue'), ('Backlog', 'gray')]]
labels = [option(*o) for o in [('backend', 'purple'), ('frontend', 'pink'), ('infra', 'orange'), ('mcp', 'teal'), ('email', 'yellow')]]
projects = [option(PROJECT_NAME, 'blue')]

C = {
    'title': col('Summary', 'title'),
    'key': col('Key', 'rich-text'),
    'type': col('Type', 'select', {'options': types}),
    'status': col('Status', 'select', {'options': statuses}),
    'priority': col('Priority', 'select', {'options': priorities}),
    'assignee': col('Assignee', 'member'),
    'reporter': col('Reporter', 'member'),
    'parent': col('Parent', 'rich-text'),
    'sprint': col('Sprint', 'select', {'options': sprints}),
    'points': col('Story Points', 'number', {'decimal': 0, 'format': 'number'}),
    'labels': col('Labels', 'multi-select', {'options': labels}),
    'due': col('Due', 'date'),
    'project': col('Project', 'select', {'options': projects}),
}


def opt_id(options, value):
    return next(o['id'] for o in options if o['value'] == value)


DAY = 86400000
now = int(time.time() * 1000)

# (type, summary, status, priority, parent, sprint, points, labels, due_in_days, description)
TICKETS = [
    ('Epic', 'Self-host AFFiNE on Cloudflare', 'Done', 'High', None, 'Sprint 1', None, ['infra'], -2,
     'Run AFFiNE in a Cloudflare Container with Supabase as the database and R2 for files.'),
    ('Epic', 'Ticket management over MCP', 'In Progress', 'High', None, 'Sprint 2', None, ['mcp'], 14,
     'Let AI clients read and update tickets on these boards through the workspace MCP server.'),
    ('Story', 'Deploy the AFFiNE container on Cloudflare', 'Done', 'High', 'SZ-1', 'Sprint 1', 5, ['infra'], -3,
     'Worker in front of a Container, pinned to WEUR next to the database.'),
    ('Task', 'Send email through the Mail Mario bridge', 'Done', 'Medium', 'SZ-1', 'Sprint 1', 3, ['email', 'backend'], -2,
     'Local SMTP server in the container that relays mail to the Mail Mario API.'),
    ('Bug', 'Invites fail with TOO_MANY_REQUEST', 'Done', 'High', 'SZ-1', 'Sprint 1', 2, ['backend'], -1,
     'Unverified accounts may only invite one person at a time. Verify the admin email.'),
    ('Story', 'Find tickets by assignee and project', 'In Review', 'High', 'SZ-2', 'Sprint 2', 5, ['mcp', 'backend'], 3,
     'list_tickets takes user and project filters and searches the whole workspace.'),
    ('Story', 'Support sub-tasks in the MCP tools', 'In Progress', 'Medium', 'SZ-2', 'Sprint 2', 5, ['mcp'], 7,
     'Tickets expose their parent and sub-tasks; create_ticket can create a sub-task.'),
    ('Task', 'Build the server image from the fork', 'To Do', 'Highest', 'SZ-2', 'Sprint 2', 3, ['infra'], 2,
     'Fork AFFiNE, run the Deploy to Cloudflare workflow with deploy off, then deploy locally.'),
    ('Sub-task', 'Read the Parent column', 'In Progress', 'Medium', 'SZ-7', 'Sprint 2', 2, ['mcp'], 5,
     'Resolve parent keys and list sub-tasks under each ticket.'),
    ('Sub-task', 'Write tests for sub-tasks', 'To Do', 'Medium', 'SZ-7', 'Sprint 2', 1, ['mcp'], 6,
     'Cover parent lookup, sub-task listing and creating a sub-task.'),
    ('Sub-task', 'Create the GitHub fork', 'To Do', 'High', 'SZ-8', 'Sprint 2', 1, ['infra'], 1,
     'Run fork-and-build.sh.'),
    ('Task', 'Move database and server to Asia', 'To Do', 'Low', None, 'Backlog', 8, ['infra'], None,
     'Supabase in Mumbai or Singapore and the APAC region for the container.'),
]

rows, cells = [], {}
for i, (type_, summary, status, prio, parent, sprint, points, labs, due, desc) in enumerate(TICKETS, start=1):
    row_id = nid()
    # Snapshot import doesn't keep links between docs, so titles stay plain
    # text; opening a ticket offers "create a linked doc" for its description.
    rows.append({
        'type': 'block', 'id': row_id, 'flavour': 'affine:paragraph', 'version': 1,
        'props': {'type': 'text', 'text': text(summary), 'collapsed': False},
        'children': [],
    })

    def cell(name, value):
        return {'columnId': C[name]['id'], 'value': value}

    row = {
        C['key']['id']: cell('key', text(f'{PROJECT_KEY}-{i}')),
        C['type']['id']: cell('type', opt_id(types, type_)),
        C['status']['id']: cell('status', opt_id(statuses, status)),
        C['priority']['id']: cell('priority', opt_id(priorities, prio)),
        C['sprint']['id']: cell('sprint', opt_id(sprints, sprint)),
        C['labels']['id']: cell('labels', [opt_id(labels, l) for l in labs]),
        C['project']['id']: cell('project', projects[0]['id']),
    }
    if parent:
        row[C['parent']['id']] = cell('parent', text(parent.replace('SZ-', f'{PROJECT_KEY}-')))
    if points is not None:
        row[C['points']['id']] = cell('points', points)
    if due is not None:
        row[C['due']['id']] = cell('due', now + due * DAY)
    if ME:
        row[C['assignee']['id']] = cell('assignee', [ME])
        row[C['reporter']['id']] = cell('reporter', [ME])
    cells[row_id] = row

column_list = list(C.values())
ids = {k: c['id'] for k, c in C.items()}
empty_filter = {'type': 'group', 'op': 'and', 'conditions': []}
header = {'titleColumn': ids['title']}

board_view = {
    'id': nid(), 'name': 'Board', 'mode': 'kanban',
    # the card header already shows the summary
    'columns': [{'id': c['id'], 'hide': k not in ('key', 'type', 'priority', 'assignee', 'points', 'parent')}
                for k, c in C.items()],
    'filter': empty_filter,
    'groupBy': {'type': 'groupBy', 'columnId': ids['status'], 'name': 'select', 'hideEmpty': True},
    'header': header,
    'groupProperties': [{'key': o['id'], 'hide': False, 'manuallyCardSort': []} for o in statuses],
}
table_width = {'title': 320, 'key': 90, 'type': 110, 'status': 130, 'priority': 110, 'assignee': 150,
               'reporter': 150, 'parent': 90, 'sprint': 110, 'points': 110, 'labels': 180, 'due': 130, 'project': 180}
backlog_view = {
    'id': nid(), 'name': 'Backlog', 'mode': 'table',
    'columns': [{'id': c['id'], 'width': table_width[k], 'hide': False} for k, c in C.items()],
    'filter': empty_filter,
    'groupBy': {'type': 'groupBy', 'columnId': ids['sprint'], 'name': 'select'},
    'header': header,
}
epics_view = {
    'id': nid(), 'name': 'By epic & type', 'mode': 'kanban',
    'columns': [{'id': c['id'], 'hide': k not in ('key', 'status', 'parent', 'assignee')}
                for k, c in C.items()],
    'filter': empty_filter,
    'groupBy': {'type': 'groupBy', 'columnId': ids['type'], 'name': 'select', 'hideEmpty': True},
    'header': header,
    'groupProperties': [{'key': o['id'], 'hide': False, 'manuallyCardSort': []} for o in types],
}

database = {
    'type': 'block', 'id': nid(), 'flavour': 'affine:database', 'version': 3,
    'props': {
        'views': [board_view, backlog_view, epics_view],
        'title': text(f'{PROJECT_NAME} ({PROJECT_KEY})'),
        'cells': cells,
        'columns': column_list,
    },
    'children': rows,
}


GUIDE = [
    para('How this board works', 'h2'),
    para(f'Every row is a ticket. Key is the ticket id ({PROJECT_KEY}-1, {PROJECT_KEY}-2, …). Type is Epic, Story, Task, Bug or Sub-task.'),
    para('Hierarchy works like Jira: a Story, Task or Bug sets Parent to its Epic\'s key, and a Sub-task sets Parent to its Story\'s or Task\'s key.'),
    para('Open a ticket (hover a card and click the expand icon) to see all its fields. Click "create a linked doc" there to write its description.'),
    para('Views: Board (kanban by Status), Backlog (table by Sprint), By epic & type (kanban by Type).'),
    para('For a new project, duplicate this page and change the Project option and the key prefix.'),
]

doc_id = nid()
note = {
    'type': 'block', 'id': nid(), 'flavour': 'affine:note', 'version': 1,
    'props': {
        'xywh': '[0,0,1600,1200]',
        'background': {'dark': '#252525', 'light': '#ffffff'},
        'index': 'a0', 'lockedBySelf': False, 'hidden': False, 'displayMode': 'both',
        'edgeless': {'style': {'borderRadius': 8, 'borderSize': 4, 'borderStyle': 'none',
                               'shadowType': '--affine-note-shadow-box'}},
    },
    'children': [database, *GUIDE],
}
snapshot = {
    'type': 'page',
    'meta': {'id': doc_id, 'title': f'{PROJECT_KEY} Board', 'createDate': now, 'tags': []},
    'blocks': {
        'type': 'block', 'id': nid(), 'flavour': 'affine:page', 'version': 2,
        'props': {'title': text(f'{PROJECT_KEY} Board')},
        'children': [
            {'type': 'block', 'id': nid(), 'flavour': 'affine:surface', 'version': 5,
             'props': {'elements': {}}, 'children': []},
            note,
        ],
    },
}

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr(f'{PROJECT_KEY} Board-{doc_id}.snapshot.json', json.dumps(snapshot))
print(OUT, len(TICKETS), 'tickets')
