import { defaultTreeAdapter, parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { convertExpression, simplePath, type ExprCtx, type RepeatScope } from './expr.js';
import type { MigrationWarning } from './types.js';
import { camelCase, cap, pascalCase, setterName } from './util.js';

type PNode = DefaultTreeAdapterMap['node'];
type PElement = DefaultTreeAdapterMap['element'];

export interface TemplateCtx extends ExprCtx {
  /** kebab tag -> import path of the migrated component */
  requires: Map<string, string>;
  imports: Map<string, string>; // default import local name -> module
  sideEffectImports: Set<string>;
  /** ref name -> TS element type */
  refTypes: Map<string, string>;
  usesFragment: boolean;
  usesChildren: boolean;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const ATTR_MAP: Record<string, string> = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength',
  minlength: 'minLength', colspan: 'colSpan', rowspan: 'rowSpan', autofocus: 'autoFocus', autocomplete: 'autoComplete',
  contenteditable: 'contentEditable', spellcheck: 'spellCheck', novalidate: 'noValidate', enctype: 'encType',
  accesskey: 'accessKey', crossorigin: 'crossOrigin', srcset: 'srcSet', usemap: 'useMap', datetime: 'dateTime',
  charset: 'charSet', frameborder: 'frameBorder', cellpadding: 'cellPadding', cellspacing: 'cellSpacing',
};

const EVENT_MAP: Record<string, string> = {
  click: 'onClick', dblclick: 'onDoubleClick', change: 'onChange', input: 'onInput', submit: 'onSubmit',
  keyup: 'onKeyUp', keydown: 'onKeyDown', keypress: 'onKeyPress', blur: 'onBlur', focus: 'onFocus',
  mouseover: 'onMouseOver', mouseout: 'onMouseOut', mouseenter: 'onMouseEnter', mouseleave: 'onMouseLeave',
  mousedown: 'onMouseDown', mouseup: 'onMouseUp', scroll: 'onScroll', drop: 'onDrop', dragover: 'onDragOver',
  paste: 'onPaste', contextmenu: 'onContextMenu', load: 'onLoad', error: 'onError',
};

const ELEMENT_TYPES: Record<string, string> = {
  input: 'HTMLInputElement', textarea: 'HTMLTextAreaElement', select: 'HTMLSelectElement', div: 'HTMLDivElement',
  button: 'HTMLButtonElement', form: 'HTMLFormElement', span: 'HTMLSpanElement', canvas: 'HTMLCanvasElement',
  img: 'HTMLImageElement', video: 'HTMLVideoElement', ul: 'HTMLUListElement', a: 'HTMLAnchorElement',
};

export function createTemplateCtx(base: Omit<TemplateCtx, 'imports' | 'sideEffectImports' | 'refTypes' | 'usesFragment' | 'usesChildren' | 'repeatStack' | 'flags' | 'requires'> & Partial<Pick<TemplateCtx, 'requires'>>): TemplateCtx {
  return {
    ...base,
    requires: base.requires ?? new Map(),
    imports: new Map(),
    sideEffectImports: new Set(),
    refTypes: new Map(),
    usesFragment: false,
    usesChildren: false,
    repeatStack: [],
    flags: { usesValueConverters: false },
  };
}

const isElement = (n: PNode): n is PElement => 'tagName' in n;
const isText = (n: PNode): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text';
const isComment = (n: PNode): n is DefaultTreeAdapterMap['commentNode'] => n.nodeName === '#comment';

type Part = { type: 'text'; value: string } | { type: 'expr'; value: string };

/** Split text on `${...}` interpolations, respecting nested braces and strings. */
export function splitInterpolation(text: string): Part[] {
  const parts: Part[] = [];
  let i = 0;
  let buf = '';
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      let quote: string | null = null;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; }
        else if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
        j++;
      }
      if (depth === 0) {
        if (buf) parts.push({ type: 'text', value: buf });
        buf = '';
        parts.push({ type: 'expr', value: text.slice(i + 2, j - 1) });
        i = j;
        continue;
      }
    }
    buf += text[i++];
  }
  if (buf) parts.push({ type: 'text', value: buf });
  return parts;
}

const JSX_TEXT_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '{': "{'{'}", '}': "{'}'}" };
function escapeJsxText(s: string): string {
  return s.replace(/[&<>{}]/g, (c) => JSX_TEXT_ESCAPES[c]);
}

function escapeTemplateLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function warn(ctx: TemplateCtx, message: string, needsAi = false, severity: MigrationWarning['severity'] = 'warning') {
  ctx.warnings.push({ severity, message, needsAi });
}

function jsxAttrString(name: string, value: string): string {
  if (!/["&\n\r{}]/.test(value)) return `${name}="${value}"`;
  return `${name}={${JSON.stringify(value)}}`;
}

/** Attribute value that may contain interpolation -> JSX attribute. */
function attrFromValue(name: string, value: string, ctx: TemplateCtx): string {
  const parts = splitInterpolation(value);
  if (!parts.some((p) => p.type === 'expr')) return jsxAttrString(name, value);
  if (parts.length === 1) return `${name}={${convertExpression(parts[0].value, ctx).code}}`;
  const body = parts
    .map((p) => (p.type === 'text' ? escapeTemplateLiteral(p.value) : `\${${convertExpression(p.value, ctx).code}}`))
    .join('');
  return `${name}={\`${body}\`}`;
}

function styleObjectFromCss(css: string): string | null {
  const entries: string[] = [];
  for (const decl of css.split(';')) {
    const t = decl.trim();
    if (!t) continue;
    const idx = t.indexOf(':');
    if (idx < 0) return null;
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();
    if (val.includes('${')) return null;
    const prop = key.startsWith('--') ? JSON.stringify(key) : camelCase(key);
    entries.push(`${prop}: ${JSON.stringify(val)}`);
  }
  return `{ ${entries.join(', ')} }`;
}

function assignHandler(ctx: TemplateCtx, rootExpr: string, valueJs: string): string | null {
  const sp = simplePath(rootExpr);
  if (!sp) return null;
  if (ctx.repeatStack.some((r) => r.itemName === sp.root)) return null;
  if (!ctx.vmNames.has(sp.root)) return null;
  ctx.assigned.add(sp.root);
  const build = (depth: number): string => {
    const base = [sp.root, ...sp.path.slice(0, depth)].join('.');
    const key = sp.path[depth];
    const inner = depth === sp.path.length - 1 ? valueJs : build(depth + 1);
    return `{ ...${base}, ${key}: ${inner} }`;
  };
  const arg = sp.path.length === 0 ? valueJs : build(0);
  return `${setterName(sp.root)}(${arg})`;
}

interface Built {
  attrs: string[];
  repeat?: string;
  ifCond?: string;
  childrenOverride?: string;
}

function buildAttributes(el: PElement, ctx: TemplateCtx, isCustom: boolean): Built {
  const tag = el.tagName;
  const attrMap = new Map(el.attrs.map((a) => [a.name, a.value]));
  const type = attrMap.get('type');
  const out: Built = { attrs: [] };

  const classParts: string[] = []; // JS expressions (quoted strings or expressions)
  let staticClass = '';
  let styleStatic: string | null = null;
  let showCond: string | undefined;
  let styleBound = false;
  const handled = new Set<string>();

  for (const a of el.attrs) {
    const { name, value } = a;
    if (handled.has(name)) continue;

    if (name === 'repeat.for') { out.repeat = value; continue; }
    if (name === 'if.bind') { out.ifCond = value; continue; }
    if (name === 'else' || name === 'else.bind') { warn(ctx, '`else` has no direct equivalent; invert the condition of the matching `if.bind`.', true); continue; }
    if (name === 'show.bind' || name === 'show.one-way' || name === 'show.to-view') { showCond = convertExpression(value, ctx).code; continue; }
    if (name === 'ref') {
      ctx.refTypes.set(value, ELEMENT_TYPES[tag] ?? (isCustom ? 'any' : 'HTMLElement'));
      out.attrs.push(`ref={${value}}`);
      continue;
    }
    if (/^(view-model|view|element|controller)\.ref$/.test(name)) {
      warn(ctx, `\`${name}="${value}"\` has no direct equivalent; use a ref or forwardRef.`, true);
      continue;
    }
    if (name === 'class') {
      const parts = splitInterpolation(value);
      if (parts.some((p) => p.type === 'expr')) {
        classParts.push('`' + parts.map((p) => (p.type === 'text' ? escapeTemplateLiteral(p.value) : `\${${convertExpression(p.value, ctx).code}}`)).join('') + '`');
      } else staticClass = value.trim();
      continue;
    }
    if (name === 'style') {
      const parts = splitInterpolation(value);
      if (parts.some((p) => p.type === 'expr')) {
        warn(ctx, `Interpolated style="${value}" cannot be converted to a style object; review it.`, true);
        out.attrs.push(`style={${JSON.stringify(value)}}`);
        styleBound = true;
      } else {
        styleStatic = styleObjectFromCss(value);
        if (!styleStatic) warn(ctx, `Could not convert style="${value}" to an object.`, true);
      }
      continue;
    }

    const bind = name.match(/^(.+?)\.(bind|one-way|two-way|to-view|from-view|one-time)$/);
    if (bind) {
      const [, prop, mode] = bind;
      const expr = value;
      if (prop === 'class') { classParts.push(convertExpression(expr, ctx).code); continue; }
      if (prop === 'style') {
        warn(ctx, `style.bind="${expr}" expects a CSS string in Aurelia; React needs an object.`, true);
        out.attrs.push(`style={${convertExpression(expr, ctx).code}}`);
        styleBound = true;
        continue;
      }
      if (prop === 'textcontent' || prop === 'innerhtml') {
        const code = convertExpression(expr, ctx).code;
        if (prop === 'textcontent') out.childrenOverride = `{${code}}`;
        else {
          warn(ctx, `innerhtml.bind="${expr}" renders unsanitised HTML; sanitise the value before using dangerouslySetInnerHTML.`, false);
          out.attrs.push(`dangerouslySetInnerHTML={{ __html: ${code} }}`);
        }
        continue;
      }

      const isForm = !isCustom && (tag === 'input' || tag === 'textarea' || tag === 'select');
      // Radio: checked.bind + model.bind/value
      if (isForm && type === 'radio' && prop === 'checked') {
        const modelExpr = attrMap.get('model.bind');
        const staticValue = attrMap.get('value');
        const choice = modelExpr ? convertExpression(modelExpr, ctx).code : staticValue !== undefined ? JSON.stringify(staticValue) : null;
        const setter = choice && assignHandler(ctx, expr, choice);
        const cur = convertExpression(expr, ctx).code;
        if (choice && setter) {
          out.attrs.push(`checked={${cur} === ${choice}}`, `onChange={() => ${setter}}`);
          handled.add('model.bind');
          continue;
        }
        warn(ctx, `Radio binding "${name}" could not be converted automatically.`, true);
        continue;
      }
      if (isForm && (prop === 'value' || prop === 'checked')) {
        const cur = convertExpression(expr, ctx).code;
        const twoWay = mode === 'bind' || mode === 'two-way' || mode === 'from-view';
        const valueJs = prop === 'checked' ? 'event.target.checked' : type === 'number' ? 'event.target.value' : 'event.target.value';
        const setter = twoWay ? assignHandler(ctx, expr, valueJs) : null;
        out.attrs.push(`${prop}={${cur}}`);
        if (setter) out.attrs.push(`onChange={(event) => ${setter}}`);
        else if (twoWay) {
          warn(ctx, `Two-way binding \`${name}="${expr}"\` targets a repeat item or non-state value; wire up onChange manually.`, true);
          out.attrs.push('readOnly');
        } else out.attrs.push('readOnly');
        continue;
      }
      if (prop === 'model') {
        warn(ctx, `\`model.bind="${expr}"\` was mapped to \`value\`; objects are not supported by DOM values.`, false);
        out.attrs.push(`value={${convertExpression(expr, ctx).code}}`);
        continue;
      }

      const reactName = isCustom ? camelCase(prop) : ATTR_MAP[prop] ?? prop;
      const code = convertExpression(expr, ctx).code;
      out.attrs.push(`${reactName}={${code}}`);
      if (isCustom && mode === 'two-way') {
        const setter = assignHandler(ctx, expr, 'value');
        if (setter) out.attrs.push(`on${cap(camelCase(prop))}Change={(value) => ${setter}}`);
        warn(ctx, `Two-way binding on <${tag}> "${prop}": React has one-way data flow. A change callback \`on${cap(camelCase(prop))}Change\` was passed; the child must call it.`, true);
      }
      continue;
    }

    const ev = name.match(/^(.+?)\.(trigger|delegate|capture|call)$/);
    if (ev) {
      const [, evName, kind] = ev;
      const { code, usesEvent } = convertExpression(value, ctx, 'handler');
      if (isCustom && kind === 'call') {
        out.attrs.push(`${camelCase(evName)}={${usesEvent ? '(event)' : '()'} => ${code}}`);
        continue;
      }
      const reactEvent = EVENT_MAP[evName];
      if (!reactEvent) {
        warn(ctx, `Event "${evName}" on <${tag}> was mapped to on${cap(camelCase(evName))}; verify it exists in React.`, false);
      }
      const prop = reactEvent ?? `on${cap(camelCase(evName))}`;
      const needsPrevent = evName === 'submit' || (evName === 'click' && (tag === 'a' || (tag === 'button' && (!attrMap.has('type') || attrMap.get('type') === 'submit'))));
      if (needsPrevent) {
        out.attrs.push(`${prop}={(event) => { event.preventDefault(); ${code}; }}`);
      } else {
        out.attrs.push(`${prop}={${usesEvent ? '(event)' : '()'} => ${code}}`);
      }
      continue;
    }

    const cls = name.match(/^(.+)\.class$/);
    if (cls) { classParts.push(`(${convertExpression(value, ctx).code}) && ${JSON.stringify(cls[1])}`); continue; }

    // Static attributes
    const reactName = isCustom ? camelCase(name) : ATTR_MAP[name] ?? name;
    if (name.startsWith('data-') || name.startsWith('aria-')) out.attrs.push(attrFromValue(name, value, ctx));
    else if (value === '' && !isCustom && ['disabled', 'checked', 'readonly', 'required', 'selected', 'multiple', 'autofocus', 'hidden', 'async', 'defer', 'open', 'novalidate'].includes(name)) out.attrs.push(reactName);
    else out.attrs.push(attrFromValue(reactName, value, ctx));
  }

  // className
  if (classParts.length === 0) {
    if (staticClass) out.attrs.push(jsxAttrString('className', staticClass));
  } else {
    const items = [...(staticClass ? [JSON.stringify(staticClass)] : []), ...classParts];
    out.attrs.push(`className={[${items.join(', ')}].filter(Boolean).join(' ')}`);
  }

  // style
  if (!styleBound) {
    if (showCond) {
      const hide = `...((${showCond}) ? {} : { display: 'none' })`;
      const inner = styleStatic ? `${styleStatic.slice(2, -2)}, ${hide}` : hide;
      out.attrs.push(`style={{ ${inner} }}`);
    } else if (styleStatic) out.attrs.push(`style={${styleStatic}}`);
  } else if (showCond) {
    warn(ctx, 'show.bind combined with a bound style could not be merged; handle visibility manually.', true);
  }

  return out;
}

function renderChildren(nodes: PNode[], ctx: TemplateCtx): string {
  const out: string[] = [];
  nodes.forEach((n, idx) => {
    if (isComment(n)) {
      out.push(`{/* ${n.data.replace(/\*\//g, '* /').trim()} */}`);
      return;
    }
    if (isText(n)) {
      const raw = n.value;
      if (!raw.trim()) {
        if (!raw.includes('\n')) out.push("{' '}");
        return;
      }
      let collapsed = raw.replace(/\s+/g, ' ');
      if (/^\s*\n/.test(raw) || idx === 0) collapsed = collapsed.trimStart();
      if (/\n\s*$/.test(raw) || idx === nodes.length - 1) collapsed = collapsed.trimEnd();
      let s = '';
      for (const p of splitInterpolation(collapsed)) {
        s += p.type === 'text' ? escapeJsxText(p.value) : `{${convertExpression(p.value, ctx).code}}`;
      }
      if (s) out.push(s);
      return;
    }
    if (isElement(n)) out.push(renderElement(n, ctx));
  });
  return out.join('');
}

function childNodesOf(el: PElement): PNode[] {
  if (el.tagName === 'template') return defaultTreeAdapter.getTemplateContent(el as unknown as DefaultTreeAdapterMap['template']).childNodes;
  return el.childNodes;
}

function renderElement(el: PElement, ctx: TemplateCtx): string {
  const tag = el.tagName;

  if (tag === 'require') {
    const from = el.attrs.find((a) => a.name === 'from')?.value;
    if (from) {
      if (/\.(css|scss|sass|less)$/.test(from)) ctx.sideEffectImports.add(from);
      else if (/-value-converter$/.test(from)) { /* handled globally via valueConverters.ts */ }
      else if (/-binding-behavior$/.test(from)) warn(ctx, `Binding behavior "${from}" must be re-implemented manually.`, true);
      else {
        const parts = from.split('/');
        const base = parts.pop()!;
        ctx.requires.set(base, `${parts.length ? parts.join('/') + '/' : './'}${pascalCase(base)}`);
      }
    }
    return '';
  }
  if (tag === 'slot') { ctx.usesChildren = true; return '{children}'; }
  if (tag === 'router-view') { warn(ctx, '<router-view> must be replaced with React Router <Outlet />.', true); return '{/* TODO(migration): <Outlet /> */}'; }
  if (tag === 'compose') { warn(ctx, '<compose> (dynamic composition) has no direct equivalent; render the component by name or via a map.', true); return '{/* TODO(migration): <compose> */}'; }

  const isTemplate = tag === 'template';
  const isCustom = !isTemplate && tag.includes('-') && !['annotation-xml', 'font-face'].includes(tag);

  // Resolve repeat scope before building attributes so children see its locals
  const repeatAttr = el.attrs.find((a) => a.name === 'repeat.for')?.value;
  let repeatScope: RepeatScope | null = null;
  let repeatCollection = '';
  if (repeatAttr !== undefined) {
    const m = repeatAttr.match(/^\s*([A-Za-z_$][\w$]*)\s+of\s+([\s\S]+)$/);
    if (m) {
      repeatScope = { itemName: m[1], usesArray: false };
      repeatCollection = convertExpression(m[2], ctx).code;
      if (/^\d+$/.test(repeatCollection.trim())) {
        repeatCollection = `Array.from({ length: ${repeatCollection.trim()} }, (_, i) => i)`;
      }
      warn(ctx, 'repeat.for uses the array index as React key; replace key={$index} with a stable id for correct updates.', false, 'info');
    } else {
      warn(ctx, `repeat.for="${repeatAttr}" form is not supported (only "item of items").`, true);
    }
  }
  if (repeatScope) ctx.repeatStack.push(repeatScope);
  try {
    const built = buildAttributes(el, ctx, isCustom);
    if (el.attrs.some((a) => a.name === 'repeat.for') && el.attrs.some((a) => a.name === 'if.bind')) {
      warn(ctx, 'repeat.for and if.bind on the same element: verify the order of evaluation.', false);
    }
    const kids = childNodesOf(el);
    const inner = built.childrenOverride ?? renderChildren(kids, ctx);

    let name: string;
    if (isTemplate) {
      ctx.usesFragment = true;
      name = 'Fragment';
    } else if (isCustom) {
      name = pascalCase(tag);
      const path = ctx.requires.get(tag);
      if (path) ctx.imports.set(name, path);
      else {
        warn(ctx, `<${tag}> was not required in this view; assuming a global resource at ./${name}.`, false);
        ctx.imports.set(name, `./${name}`);
      }
    } else name = tag;

    const attrs = [...(repeatScope ? [`key={$index}`] : []), ...built.attrs];
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
    const keptAttrs = isTemplate ? attrs.filter((a) => a.startsWith('key=')) : attrs;
    const finalAttrStr = isTemplate ? (keptAttrs.length ? ' ' + keptAttrs.join(' ') : '') : attrStr;
    let jsx: string;
    if (isTemplate && !repeatScope) jsx = inner ? `<>${inner}</>` : '<></>';
    else if (VOID.has(name) && !inner) jsx = `<${name}${finalAttrStr} />`;
    else if (!inner) jsx = `<${name}${finalAttrStr} />`;
    else jsx = `<${name}${finalAttrStr}>${inner}</${name}>`;

    if (repeatScope) {
      const params = repeatScope.usesArray ? `${repeatScope.itemName}, $index, $array` : `${repeatScope.itemName}, $index`;
      if (!repeatScope.usesArray) { /* default */ }
      jsx = `{${repeatCollection}.map((${params}) => (${jsx}))}`;
      if (built.ifCond !== undefined) {
        jsx = `{(${convertExpression(built.ifCond, ctx).code}) && (${jsx.slice(1, -1)})}`;
      }
      return jsx;
    }
    if (built.ifCond !== undefined) return `{(${convertExpression(built.ifCond, ctx).code}) && (${jsx})}`;
    return jsx;
  } finally {
    if (repeatScope) ctx.repeatStack.pop();
  }
}

/** Convert an Aurelia view to a JSX expression string (single root; fragments wrapped). */
export function convertTemplate(html: string, ctx: TemplateCtx): string {
  const frag = parseFragment(html);
  let nodes: PNode[] = frag.childNodes;
  // Unwrap the root <template>
  const rootTemplate = nodes.filter(isElement).find((n) => n.tagName === 'template');
  if (rootTemplate && nodes.filter((n) => isElement(n) || (isText(n) && n.value.trim())).length === 1) {
    nodes = childNodesOf(rootTemplate);
  }
  const body = renderChildren(nodes, ctx).trim();
  if (!body) return 'null';
  const significant = nodes.filter((n) => isElement(n) ? n.tagName !== 'require' : isText(n) ? !!n.value.trim() : false);
  const single = significant.length === 1 && isElement(significant[0]) && !body.startsWith('{') && !body.startsWith('<>');
  return single ? body : `<>${body}</>`;
}
