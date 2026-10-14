/**
 * Platform registry. An adapter exports `validate(payload)` (throws on bad
 * input) and `publish(payload, { resume })` (returns a result object).
 * To add YouTube later: create youtube.js and register it here.
 */

import * as twitter from "./twitter.js";
import * as github from "./github.js";

export const platforms = { twitter, x: twitter, github };
