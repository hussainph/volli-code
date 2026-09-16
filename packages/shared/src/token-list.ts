/**
 * One tool field holding several values, read the way models actually write it.
 *
 * The Verb Registry's field vocabulary is deliberately small, so a list of
 * Session handles, Ticket display ids or MCP tool names all arrive as ONE
 * string. A model asked for "names separated by spaces or commas" produces
 * every combination of the two, and a parser that accepted only one of them
 * would refuse input that is plainly correct.
 *
 * Splitting is the whole parse. Whether a token names something real is always
 * the host's judgement, made against what the attachment is bound to — this
 * function has no opinion about that and never had one.
 *
 * A repeat is counted once, because every caller so far means a SET: awaiting
 * the same Session twice is one wait, and turning the same MCP tool on twice is
 * one tool.
 */
export function uniqueTokenList(raw: string): readonly string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    ),
  ];
}
