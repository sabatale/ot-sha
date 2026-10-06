import { parse } from 'acorn';

export const OPERATIONS = {
  RestaurantsAvailability: 'availabilitySha',
  MultiSearchResults: 'multiSha',
  Autocomplete: 'autoSha'
};

function property(node, name) {
  return node?.type === 'ObjectExpression'
    ? node.properties.find((item) => !item.computed &&
      (item.key?.name ?? item.key?.value) === name)?.value
    : undefined;
}

function operationNames(node) {
  if (property(node, 'kind')?.value !== 'Document') return [];
  const definitions = property(node, 'definitions');
  return (definitions?.elements || []).filter((item) =>
    property(item, 'kind')?.value === 'OperationDefinition'
  ).map((item) => property(property(item, 'name'), 'value')?.value)
    .filter((name) => Object.hasOwn(OPERATIONS, name));
}

// Parse, never execute downloaded code. Match a hash to its actual document variable,
// keeping identifiers in separate function/block scopes isolated.
export function extractHashes(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const result = {};
  function walk(node, scopes) {
    if (!node || typeof node !== 'object') return;
    if (/^(Program|BlockStatement|.*Function.*)$/.test(node.type)) {
      scopes = [...scopes, new Map()];
    }
    const scope = scopes.at(-1);
    const lookup = (name) => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].has(name)) return scopes[i].get(name);
      }
      return [];
    };
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      scope.set(node.id.name, node.init?.type === 'Identifier'
        ? lookup(node.init.name) : operationNames(node.init));
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      if (node.left.type === 'Identifier') {
        scope.set(node.left.name, operationNames(node.right));
      }
      const member = node.left;
      const key = member.computed ? member.property?.value : member.property?.name;
      if (member.type === 'MemberExpression' && key === 'documentId' &&
          member.object.type === 'Identifier' && /^[a-f0-9]{64}$/.test(node.right.value || '')) {
        for (const name of lookup(member.object.name)) {
          const field = OPERATIONS[name];
          if (result[field] && result[field] !== node.right.value) {
            throw new Error('Conflicting hashes for ' + name);
          }
          result[field] = node.right.value;
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => walk(child, scopes));
      else if (value?.type) walk(value, scopes);
    }
  }
  walk(ast, []);
  return result;
}

export function scriptUrl(value, base) {
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) &&
      /\/(?:multi-search|chunk)-[^/]+\.js$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function chunkLinks(source, base) {
  const links = new Set();
  for (const match of source.matchAll(/["']([^"'\s]+\.js(?:\?[^"'\s]*)?)["']/g)) {
    const url = scriptUrl(match[1], base);
    if (url) links.add(url);
  }
  return [...links];
}

export function missingHashes(hashes) {
  return Object.values(OPERATIONS).filter((key) => !/^[a-f0-9]{64}$/.test(hashes[key] || ''));
}
