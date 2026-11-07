// CODING_STANDARDS.md "Touch targets": a tappable element (button, link, or anything with
// onClick) has a class that makes it at least 44px tall: min-h-11, h-11 or size-11 and up,
// directly or through a #/ui constant that carries one.
import { readFileSync } from "node:fs";

const TALL = /(?:^|[\s"`])(?:min-h|h|size)-(?:1[1-9]|[2-9]\d)(?=[\s"`]|$)/;

// Words in running text fill the line box instead: 44px would break the line height.
const INLINE = new Set(["WORD"]);

/** The #/ui constants whose classes make an element tall, read from their definitions. */
function tallUiConstants() {
  const ui = readFileSync(new URL("../app/src/ui.tsx", import.meta.url), "utf8");
  const defs = new Map(
    [...ui.matchAll(/^(?:export )?const (\w+) =\s*([\s\S]*?);$/gm)].map((m) => [m[1], m[2]]),
  );
  const tall = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, text] of defs) {
      if (tall.has(name)) continue;
      const refs = [...text.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
      if (TALL.test(text) || refs.some((r) => tall.has(r))) {
        tall.add(name);
        grew = true;
      }
    }
  }
  return tall;
}

const TALL_NAMES = tallUiConstants();

function isTall(node, scope) {
  if (!node) return false;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" && TALL.test(` ${node.value} `);
    case "TemplateLiteral":
      return (
        node.quasis.some((q) => TALL.test(` ${q.value.raw} `)) ||
        node.expressions.some((e) => isTall(e, scope))
      );
    case "JSXExpressionContainer":
      return isTall(node.expression, scope);
    case "ConditionalExpression":
      return isTall(node.consequent, scope) && isTall(node.alternate, scope);
    case "BinaryExpression":
    case "LogicalExpression":
      return isTall(node.left, scope) || isTall(node.right, scope);
    case "Identifier": {
      if (TALL_NAMES.has(node.name) || INLINE.has(node.name)) return true;
      // A local const: check what it holds.
      for (let s = scope; s; s = s.upper) {
        const v = s.set.get(node.name);
        const def = v?.defs[0]?.node;
        if (def) return def.type === "VariableDeclarator" && isTall(def.init, s);
      }
      return false;
    }
    default:
      return false;
  }
}

const TAPPABLE = new Set(["button", "a", "Link"]);
// A dialog's onClick catches backdrop clicks: the backdrop is no tap target.
const NOT_TARGETS = new Set(["dialog"]);

const touchTarget = {
  meta: { type: "problem" },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const attr = (name) =>
          node.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === name);
        if (node.name.type !== "JSXIdentifier" || NOT_TARGETS.has(node.name.name)) return;
        const tag = node.name.name;
        // A component's onClick is a prop: the element it renders is checked where it is written.
        const element = tag[0] === tag[0].toLowerCase();
        const tappable = TAPPABLE.has(tag) || (element && attr("onClick"));
        if (!tappable || attr("aria-hidden")) return;
        const cls = attr("className");
        if (cls && isTall(cls.value, context.sourceCode.getScope(node))) return;
        context.report({
          node,
          message:
            "A tappable element needs a 44px touch target: add min-h-11 (or size-11), or use a #/ui button constant.",
        });
      },
    };
  },
};

export default { meta: { name: "app" }, rules: { "touch-target": touchTarget } };
