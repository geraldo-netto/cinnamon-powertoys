/*
 * Just enough of a JavaScript tokeniser to tell code from what is written in
 * it.
 *
 * Two tools need the same answer and must not disagree about it: the coverage
 * report, working out where a function ends by matching its braces, and the
 * mutation runner, which must not edit an operator that is part of a doc block
 * or a regular expression. Both would be wrong about the first interesting
 * case they met if either counted characters with a regex - this project's
 * sources are full of braces in strings, doc blocks in front of every
 * function, and patterns like /^\s+([^:]+):\s+(.*?)\s*$/.
 *
 * Nothing here parses. What it produces is a mask: the same text with every
 * character that belongs to a string, a comment or a pattern replaced by a
 * space, and every code character left where it was. Positions are therefore
 * the positions in the original, which is what lets a caller find something in
 * the mask and change it in the source.
 */

/*
 * Whether a slash here opens a pattern or divides.
 *
 * Decided the way every small scanner decides it: by what came before. After a
 * value - a name, a number, a closing bracket - a slash divides; after an
 * operator, a comma, an opening bracket or the start of the file, it opens a
 * pattern. `return /x/` is the case that makes the keyword check necessary,
 * since `return` ends in a letter and is not a value.
 */
const VALUE_KEYWORDS = /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else)$/;

function _dividesAfter(code) {
    let trimmed = code.replace(/\s+$/, "");
    if (trimmed === "")
        return false;
    if (VALUE_KEYWORDS.test(trimmed))
        return false;
    return /[A-Za-z0-9_$)\]]$/.test(trimmed);
}

/*
 * The source with everything that is not code blanked out.
 *
 * Newlines are kept wherever they were, including the ones inside a string,
 * so that a position in the mask is on the same line as the position in the
 * source. The interface XML in lib/upower.js and lib/profiles.js is one string
 * spanning thirty lines, and a mask that dropped those newlines would put
 * every line number after it out by thirty.
 */
function mask(source) {
    let out = "";

    for (let i = 0; i < source.length; i++) {
        let c = source[i];
        let next = source[i + 1];

        if (c === "/" && next === "/") {
            while (i < source.length && source[i] !== "\n") {
                out += " ";
                i++;
            }
            out += "\n";
            continue;
        }

        if (c === "/" && next === "*") {
            let end = source.indexOf("*/", i + 2);
            end = end < 0 ? source.length : end + 2;
            for (; i < end; i++)
                out += source[i] === "\n" ? "\n" : " ";
            i--;
            continue;
        }

        if (c === '"' || c === "'" || c === "`") {
            let quote = c;
            out += " ";
            i++;
            while (i < source.length && source[i] !== quote) {
                /* A backslash takes the next character with it, and where that
                 * is a newline it is still a newline: the XML strings are
                 * written across lines exactly that way. */
                if (source[i] === "\\") {
                    out += " ";
                    i++;
                    if (i < source.length)
                        out += source[i] === "\n" ? "\n" : " ";
                } else {
                    out += source[i] === "\n" ? "\n" : " ";
                }
                i++;
            }
            out += " ";
            continue;
        }

        if (c === "/" && !_dividesAfter(out)) {
            out += " ";
            i++;
            let inClass = false;
            while (i < source.length && source[i] !== "\n" && (inClass || source[i] !== "/")) {
                if (source[i] === "\\") {
                    out += " ";
                    i++;
                } else if (source[i] === "[") {
                    inClass = true;
                } else if (source[i] === "]") {
                    inClass = false;
                }
                out += " ";
                i++;
            }
            /* The closing slash, or the newline that says this was a division
             * after all and there was nothing to close. */
            out += source[i] === "\n" ? "\n" : " ";
            continue;
        }

        out += c;
    }

    return out;
}

/* Which line a position is on, counting from one. */
function lineAt(text, position) {
    let line = 1;
    for (let i = 0; i < position && i < text.length; i++) {
        if (text[i] === "\n")
            line++;
    }
    return line;
}

/*
 * Where every block closes, by the line it opened on.
 *
 * One entry per opening line, in the order they opened, since a line can open
 * more than one - `.sort((a, b) => {` opens the call and the body on the same
 * line as far as this is concerned.
 */
function blocks(source) {
    let code = mask(source);
    let opens = [];
    let closes = {};
    let line = 1;

    for (let i = 0; i < code.length; i++) {
        if (code[i] === "\n")
            line++;
        else if (code[i] === "{")
            opens.push(line);
        else if (code[i] === "}") {
            let open = opens.pop();
            if (open !== undefined)
                closes[open] = (closes[open] || []).concat([line]);
        }
    }

    return closes;
}
