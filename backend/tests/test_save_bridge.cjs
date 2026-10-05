const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function bridge(context, content, url = "https://sandbox.test/token/doc/tree/notebook.ipynb") {
  const handlers = {};
  const parent = {};
  const shell = { currentWidget: { context, content }, currentChanged: { connect() {} } };
  const window = {
    location: new URL(url),
    jupyterapp: { shell, restored: new Promise(() => {}) },
    parent,
    addEventListener: (name, callback) => { const previous = handlers[name]; handlers[name] = previous ? async event => { await previous(event); await callback(event); } : callback; },
    setTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/jupyter_bridge.js'), 'utf8'), {
    window, URL, WeakSet, Promise,
    document: { documentElement: {} },
    ResizeObserver: class { observe() {} },
    __PARENT_ORIGINS__: ['https://app.test'],
  });
  return { handlers, parent, shell };
}

// @lat: [[editing#Save serialization]]
test('native and bridge saves wait for the preceding metadata refresh', async () => {
  let release, started = 0;
  const context = {
    path: 'notebook.ipynb', ready: Promise.resolve(),
    async save() {
      started++;
      if (started === 1) await new Promise(resolve => { release = resolve; });
    },
  };
  const { handlers, parent } = bridge(context);
  const first = context.save();
  await Promise.resolve();
  let acknowledged = false;
  parent.postMessage = () => { acknowledged = true; };
  const second = handlers.message({ source: parent, origin: 'https://app.test', data: {
    type: 'vercel-notebook-save', token: 'token', id: 'save-2',
  } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started, 1);
  assert.equal(acknowledged, false);
  release();
  await Promise.all([first, second]);
  assert.equal(started, 2);
  assert.equal(acknowledged, true);
});

test('a failed save stays rejected without blocking later saves', async () => {
  let attempts = 0;
  const context = { async save() { if (++attempts === 1) throw Error('Save cancelled'); } };
  bridge(context);
  const first = context.save();
  const second = context.save();
  await assert.rejects(first, /Save cancelled/);
  await second;
  assert.equal(attempts, 2);
});

// @lat: [[chat#Live document tests]]
test('chat reads unsaved cells and refuses stale replacements or untrusted messages', async () => {
  let source = 'print(42)';
  const cell = { getId: () => 'cell-1', getSource: () => source,
    setSource: value => { source = value; }, toJSON: () => ({ cell_type: 'code', source, outputs: [] }) };
  const { handlers, parent } = bridge({ path: 'notebook.ipynb', ready: Promise.resolve(), save() {} },
    { model: { sharedModel: { cells: [cell] } } });
  let response;
  parent.postMessage = value => { response = value; };
  async function call(tool, args, overrides = {}) {
    response = undefined;
    handlers.message({ source: parent, origin: 'https://app.test', data: {
      type: 'vercel-notebook-tool', token: 'token', id: 'tool-1', tool, args,
    }, ...overrides });
    await new Promise(resolve => setImmediate(resolve));
    return response;
  }
  assert.equal((await call('read_notebook', {})).result.cells[0].source, source);
  const conflict = (await call('replace_cell', { cell_id: 'cell-1', expected_source: 'old', source: 'bad' })).result;
  assert.equal(conflict.code, 'source_conflict');
  assert.equal(conflict.current_cell.source, source);
  assert.equal(conflict.current_cell.truncated, false);
  assert.equal(source, 'print(42)');
  assert.equal(await call('replace_cell', {}, { origin: 'https://evil.test' }), undefined);
  assert.equal(await call('read_notebook', {}, { source: {} }), undefined);
  await call('replace_cell', { cell_id: 'cell-1', expected_source: source, source: 'print(43)' });
  assert.equal(source, 'print(43)');
  const staleRun = (await call('run_cell', { cell_id: 'cell-1', expected_source: 'print(42)' })).result;
  assert.equal(staleRun.current_cell.source, 'print(43)');
  await call('replace_cell', { cell_id: 'cell-1', expected_source: staleRun.current_cell.source, source: 'print(44)' });
  assert.equal(source, 'print(44)');
  assert.equal((await call('run_cell', { cell_id: 'gone', expected_source: '' })).result.code, 'cell_missing');
  assert.match((await call('future_tool', { cell_id: 'cell-1' })).error, /Unsupported notebook tool/);
});

// @lat: [[chat#Unfocused notebook saves]]
test('save finds the open notebook when Jupyter has no focused widget', async () => {
  let saved = 0;
  const context = { path: 'notebook.ipynb', ready: Promise.resolve(), async save() { saved++; } };
  const { handlers, parent, shell } = bridge(context);
  const widget = shell.currentWidget;
  shell.currentWidget = null;
  shell.widgets = function* () { yield widget; };
  let response;
  parent.postMessage = value => { response = value; };
  await handlers.message({ source: parent, origin: 'https://app.test', data: {
    type: 'vercel-notebook-save', token: 'token', id: 'save-unfocused',
  } });
  assert.equal(saved, 1);
  assert.equal(response.type, 'vercel-notebook-saved');
});

// @lat: [[chat#Notebook scrolling tests]]
test('scroll tools page within the notebook and target stable cell IDs without changing content', async () => {
  const calls = [];
  const scroller = { scrollTop: 800, clientHeight: 500, scrollBy({ top }) { this.scrollTop += top; } };
  const content = { outerNode: scroller, model: { sharedModel: { cells: [
    { getId: () => 'first' }, { getId: () => 'last' },
  ] } }, async scrollToItem(index, alignment) { calls.push([index, alignment]); } };
  const { handlers, parent } = bridge({ path: 'notebook.ipynb', ready: Promise.resolve(), save() {} }, content);
  let reply;
  parent.postMessage = value => { reply = value; };
  async function scroll(args) {
    await handlers.message({ source: parent, origin: 'https://app.test', data: {
      type: 'vercel-notebook-tool', token: 'token', id: 'scroll', tool: 'scroll_notebook', args,
    } });
    await new Promise(resolve => setImmediate(resolve));
    return reply;
  }
  await scroll({ direction: 'up' }); assert.equal(scroller.scrollTop, 400);
  await scroll({ direction: 'down' }); assert.equal(scroller.scrollTop, 800);
  await scroll({ direction: 'bottom' });
  await scroll({ direction: 'cell', cell_id: 'first', alignment: 'center' });
  assert.deepEqual(calls, [[1, 'end'], [0, 'center']]);
  assert.match((await scroll({ direction: 'cell', cell_id: 'missing' })).error, /not found/);
  assert.match((await scroll({ direction: 'sideways' })).error, /Invalid/);
});

// @lat: [[chat#Bridge compatibility and recovery]]
test('capability handshake is authenticated and works before the notebook loads', async () => {
  const { handlers, parent } = bridge({ path: 'notebook.ipynb', save() {} });
  let reply;
  parent.postMessage = value => { reply = value; };
  const message = { source: parent, origin: 'https://app.test', data: {
    type: 'vercel-notebook-capabilities', token: 'token', id: 'handshake',
  } };
  await handlers.message({ ...message, origin: 'https://evil.test' });
  assert.equal(reply, undefined);
  await handlers.message(message);
  assert.equal(reply.id, 'handshake');
  assert.equal(reply.result.protocol, 2);
});

// @lat: [[editing#Browser recovery tests]]
test('exports full live notebook without server access, even while a save is stuck', async () => {
  const notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { cell_type: 'code', id: 'a', source: 'unsaved code', metadata: {}, execution_count: 1,
      outputs: [{ output_type: 'display_data', data: { 'image/png': 'full-image-data' }, metadata: {} }] },
  ] };
  const context = { path: 'notebook.ipynb', ready: new Promise(() => {}),
    model: { toJSON: () => notebook }, save() { throw Error('410'); } };
  const { handlers, parent } = bridge(context);
  let response;
  parent.postMessage = value => { response = value; };
  const event = { source: parent, origin: 'https://app.test', data: {
    type: 'vercel-notebook-export', token: 'token', id: 'recover',
  } };
  await handlers.message({ ...event, origin: 'https://evil.test' });
  assert.equal(response, undefined);
  await handlers.message({ ...event, data: { ...event.data, token: 'wrong' } });
  assert.equal(response, undefined);
  await handlers.message(event);
  assert.deepEqual(JSON.parse(response.source), notebook);
});

// @lat: [[editing#Shared document bridge tests]]
for (const route of ['doc/tree', 'doc/workspaces/nf-explicit/tree', 'doc/workspaces/auto-Z/tree']) {
test(`shared-server bridge uses the exact document path and token through ${route}`,  async () => {
  const context = { path: 'notebooks/abc/notebook-unique.ipynb', ready: Promise.resolve(), save: async () => {} };
  const { handlers, parent } = bridge(context, {},
    `https://sandbox.test/server-cap/${route}/notebooks/abc/notebook-unique.ipynb?nf_editor_token=editor-cap`);
  let response;
  parent.postMessage = value => { response = value; };
  await handlers.message({ source: parent, origin: 'https://app.test', data: {
    type: 'vercel-notebook-save', token: 'server-cap', id: 'bad',
  } });
  assert.equal(response, undefined);
  await handlers.message({ source: parent, origin: 'https://app.test', data: {
    type: 'vercel-notebook-save', token: 'editor-cap', id: 'good',
  } });
  assert.equal(response.id, 'good');
  assert.equal(response.error, undefined);
});
}

// @lat: [[editing#Retained editor connection tests]]
test('connection reports distinguish a loaded notebook from a connected kernel', async () => {
  const { handlers, parent, shell } = bridge({ path: 'notebook.ipynb', save() {} });
  let reply;
  parent.postMessage = value => { reply = value; };
  const message = { source: parent, origin: 'https://app.test', data: {
    type: 'vercel-notebook-capabilities', token: 'token', id: 'connection',
  } };
  await handlers.message(message);
  assert.equal(reply.result.ready, true);
  assert.equal(reply.result.kernel_started, false);
  assert.equal(reply.result.connected, false);
  shell.currentWidget.sessionContext = { session: { kernel: { connectionStatus: 'connected' } } };
  await handlers.message(message);
  assert.equal(reply.result.connected, true);
  assert.equal(reply.result.kernel_started, true);
  shell.currentWidget.sessionContext.session.kernel.connectionStatus = 'disconnected';
  await handlers.message(message);
  assert.equal(reply.result.connected, false);
});
