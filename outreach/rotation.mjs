// Variables are tokens, so their double braces never become phrase groups.
export function parseRotation(text, html = false) {
  if (!text.includes("|")) {
    const nodes = [];
    let previous = 0;
    for (const match of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      nodes.push(text.slice(previous, match.index), { variable: match[1] });
      previous = match.index + match[0].length;
    }
    nodes.push(text.slice(previous));
    return nodes;
  }
  const balance = (alternatives) => {
    if (!html) return alternatives;
    const stack = [];
    let generated = 0;
    const result = alternatives.map((nodes) => {
      const prefix = stack.map((tag) => tag.open).join("");
      for (const node of nodes) {
        if (typeof node !== "string") continue;
        for (const match of node.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
          const name = match[2].toLowerCase();
          if (["img", "br", "hr", "input", "wbr"].includes(name)) continue;
          if (match[1]) {
            if (stack.at(-1)?.name !== name)
              throw new Error(
                "Ротация фраз: разместите группу целиком внутри одного форматирования",
              );
            stack.pop();
          } else {
            if (stack.length >= 32)
              throw new Error("Ротация фраз: слишком сложное форматирование");
            stack.push({ name, open: match[0] });
          }
        }
      }
      const suffix = stack.toReversed().map((tag) => `</${tag.name}>`);
      generated +=
        prefix.length +
        suffix.join("").length +
        nodes.reduce(
          (sum, node) => sum + (typeof node === "string" ? node.length : 1),
          0,
        );
      if (generated > 400_000)
        throw new Error("Ротация фраз: письмо слишком большое");
      return [prefix, ...nodes, ...suffix];
    });
    if (stack.length)
      throw new Error(
        "Ротация фраз: разместите группу целиком внутри одного форматирования",
      );
    return result;
  };
  let pos = 0;
  const read = (depth = 0) => {
    if (depth > 32) throw new Error("Ротация фраз: слишком много скобок");
    const alternatives = [[]];
    let literal = "";
    const flush = () => {
      if (literal) alternatives.at(-1).push(literal);
      literal = "";
    };
    while (pos < text.length) {
      const variable =
        text.startsWith("{{", pos) &&
        text.slice(pos).match(/^\{\{\s*([^{}]+?)\s*\}\}/);
      if (variable) {
        flush();
        alternatives.at(-1).push({ variable: variable[1] });
        pos += variable[0].length;
      } else if (text[pos] === "{") {
        flush();
        pos++;
        const group = read(depth + 1);
        if (group.alternatives.length > 1) {
          if (depth)
            throw new Error("Ротация фраз: вложенные группы не поддерживаются");
          alternatives
            .at(-1)
            .push({ alternatives: balance(group.alternatives) });
        } else
          alternatives
            .at(-1)
            .push(
              "{",
              ...group.alternatives[0],
              ...(group.closed ? ["}"] : []),
            );
      } else if (depth && text[pos] === "}") {
        flush();
        pos++;
        return { alternatives, closed: true };
      } else if (depth && text[pos] === "|") {
        flush();
        alternatives.push([]);
        pos++;
      } else literal += text[pos++];
    }
    flush();
    if (depth && alternatives.length > 1)
      throw new Error("Ротация фраз: не закрыта фигурная скобка");
    // An unmatched ordinary brace remains literal text.
    return { alternatives, closed: false };
  };
  return read().alternatives[0];
}
