// Pass sırası: önce çalışma anı katmanları açılır, sonra statik sadeleştirmeler; her tur bu sırayla döner.
import * as layers from '../passes/layers.js';
import * as fold from '../passes/fold.js';
import * as propagate from '../passes/propagate.js';
import * as guards from '../passes/guards.js';
import * as dead from '../passes/dead.js';
import * as integrity from '../passes/integrity.js';
import * as inline from '../passes/inline.js';
import * as unused from '../passes/unused.js';
import * as tags from '../passes/tags.js';
import * as gotoFlow from '../passes/goto.js';
import * as strings from '../passes/strings.js';
import * as rename from '../passes/rename.js';
import * as tables from '../passes/tables.js';
import * as callees from '../passes/callees.js';
import * as prege from '../passes/prege.js';
import * as banner from '../passes/banner.js';

export const PASSES = [layers, guards, gotoFlow, fold, strings, prege, propagate, tables, callees, dead, integrity, inline, unused, rename, banner, tags];
