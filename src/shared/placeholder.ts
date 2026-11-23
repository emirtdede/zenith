/**
 * The single glyph Zenith uses for "not measured" (DEF-118).
 *
 * Three screens and two formatters need to say "this value was never read", and
 * they must say it the same way. Before this module each of them held its own
 * literal, which meant a change of glyph was five edits and a silent
 * disagreement waiting to happen.
 *
 * It is an ASCII hyphen by policy: the project forbids typographic dashes in
 * first-party text, and `check:dashes` fails the build on any U+2014 or U+2013
 * outside vendored licence files. The *meaning* is carried by the name, not the
 * character - a bare "-" in source says nothing, `NOT_MEASURED` says everything.
 */
export const NOT_MEASURED = "-";
