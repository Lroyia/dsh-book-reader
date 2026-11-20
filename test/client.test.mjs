/**
 * The shelf must not take the search field away from the user.
 *
 * The search filters the shelf while the query is typed. When the query finds
 * nothing, the shelf used to swap its whole toolbar for the "no book matches"
 * notice: the search field went with it, the keyboard went with it, and the
 * query could no longer be changed. The shelf was stuck until the panel was
 * left and opened again.
 *
 * These tests drive the real browser half in a stub browser: the module is
 * loaded the way the page loads it, the panel is rendered by a stub React,
 * and the tree that comes out is read for the search field.
 *
 * Run with: node --test test/client.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = await readFile(join(here, '..', 'client.js'), 'utf8');

/**
 * Load the browser half the way the page loads it.
 *
 * The file hands itself to the page's module loader, so the loader is stubbed
 * and the module is kept for the test.
 * @returns {{id: string, factory: Function}} the loaded module.
 */
function loadClient() {
  let captured = undefined;
  const page = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  };
  // The file is a plain script: it hands itself to the page's loader.
  const run = new Function('window', clientSource);
  run(page);
  if (captured === undefined) throw new Error('the client half did not register itself');
  return captured;
}

/**
 * A React that only builds a tree.
 *
 * The panel is a set of functions that return elements, so a React that
 * records what it is given is enough to look at what the panel puts on the
 * screen. The hooks keep their first value: the tests are about the shape of
 * the tree, not about the states that follow it.
 * @returns {object} the stub React.
 */
function stubReact() {
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const next = { ...(props ?? {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return { type, props: next };
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    },
    useEffect() {},
    useRef(initial) {
      return { current: initial };
    },
    useCallback(callback) {
      return callback;
    },
    useMemo(factory) {
      return factory();
    },
  };
  return React;
}

/**
 * The panel as the page mounts it.
 * @returns {Function} the panel component.
 */
function loadPanel() {
  const React = stubReact();
  const spec = loadClient();
  const module = spec.factory((name) => {
    if (name !== 'react') throw new Error(`the client half asked for ${name}`);
    return React;
  });
  const mounted = {};
  const ctx = {
    effect: (run) => {
      const dispose = run();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      getLocale: () => ({ active: 'zh' }),
      subscribe: () => () => {},
    },
    slots: {
      inject: (name, register) => {
        mounted[name] = register();
      },
      register: (entry, Component) => {
        mounted[entry.key ?? entry.name] = Component;
        return () => {};
      },
    },
  };
  module.apply(ctx);
  const panel = mounted['book-reader'];
  if (typeof panel !== 'function') throw new Error('the panel did not register itself');
  return panel;
}

/**
 * The translation used by the tests: the key, with its values behind it.
 * @param {string} key - the dictionary key.
 * @param {object} [params] - the values.
 * @returns {string} the text.
 */
function translate(key, params) {
  return params === undefined ? key : `${key}:${JSON.stringify(params)}`;
}

/**
 * Walk a tree of elements.
 * @param {unknown} node - the node to walk.
 * @param {Function} visit - called with every element.
 * @param {object[]} found - the elements that were found.
 * @returns {object[]} the elements that were found.
 */
function walk(node, visit, found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, found);
    return found;
  }
  visit(node, found);
  walk(node.props?.children, visit, found);
  return found;
}

/**
 * Every text the tree holds.
 *
 * Only the children are read: a class name or a placeholder is not text the
 * user sees.
 * @param {unknown} node - the node to walk.
 * @returns {string[]} the texts.
 */
function texts(node) {
  const found = [];
  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      found.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    visit(value.props?.children);
  };
  visit(node);
  return found;
}

test('a search that finds nothing keeps the search field', () => {
  const Panel = loadPanel();
  const tree = Panel({ t: translate, locale: undefined, theme: undefined, pickDirectory: null });
  const shelf = walk(tree, (element, found) => {
    if (typeof element.type === 'function' && element.type.name === 'ShelfView') found.push(element);
  });
  assert.equal(shelf.length, 1, 'the shelf must be on the screen');

  // The query matches nothing: the field has to stay, or the query can no
  // longer be changed and the shelf is stuck.
  const searched = shelf[0].type({
    ...shelf[0].props,
    books: [],
    groups: [{ key: '', name: '', books: [] }],
    query: 'ab',
    busy: false,
  });
  const fields = walk(searched, (element, found) => {
    if (element.type === 'input' && String(element.props?.className ?? '').includes('nr-search')) found.push(element);
  });
  assert.equal(fields.length, 1, 'the search field must stay on the screen while a search finds nothing');
  assert.equal(fields[0].props.value, 'ab', 'the search field must still hold the query');
  assert.ok(
    texts(searched).some((text) => text.startsWith('shelf.empty.search')),
    'the shelf must say that nothing matched',
  );
});

test('a shelf that holds no books still asks for books', () => {
  const Panel = loadPanel();
  const tree = Panel({ t: translate, locale: undefined, theme: undefined, pickDirectory: null });
  const shelf = walk(tree, (element, found) => {
    if (typeof element.type === 'function' && element.type.name === 'ShelfView') found.push(element);
  });
  assert.equal(shelf.length, 1, 'the shelf must be on the screen');

  // No books and no query: the shelf asks for books, and does not pretend
  // that a search is running.
  const empty = shelf[0].type({
    ...shelf[0].props,
    books: [],
    groups: [{ key: '', name: '', books: [] }],
    query: '',
    busy: false,
  });
  assert.ok(
    texts(empty).some((text) => text.startsWith('shelf.empty.title')),
    'the empty shelf must ask for books',
  );
  assert.ok(
    !texts(empty).some((text) => text.startsWith('shelf.empty.search')),
    'the empty shelf must not claim that a search found nothing',
  );
});
