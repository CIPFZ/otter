// On-demand CMCD encoder chunk (ADR-005 §2): only the two functions Otter uses, so the dynamically
// imported chunk tree-shakes instead of pulling the whole @svta/cml-cmcd namespace.
export { appendCmcdQuery, toCmcdHeaders } from '@svta/cml-cmcd';
