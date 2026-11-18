import {
  isPermission,
  type CustomFunction,
  type CustomFunctionDefinition,
  type CustomFunctionKind,
  type FunctionParam,
  type SaveCustomFunctionInput,
  type SettingControl,
} from '@cod2admin/admin-store';
import { sanitizeRconArg } from './sanitize.js';

/**
 * Custom functions (docs/PLAN-custom-functions.md): validation of what the owner defines, and
 * turning a definition plus the caller's values into the commands to send. Pure, so the rules that
 * keep a value from becoming a second command are testable without a server.
 */

export class FunctionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunctionError';
  }
}

export const MAX_PARAMS = 8;
export const MAX_STEPS = 5;
export const MAX_COMMAND_LENGTH = 512;
export const MAX_FUNCTIONS = 100;
const DEFAULT_TEXT_LENGTH = 128;
const MAX_TEXT_LENGTH = 256;
const MAX_OPTIONS = 50;

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,23}$/;
const CVAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A value that goes into a command unquoted must be one token. */
const TOKEN = /^[\w.:+-]{1,64}$/;
const ICON = /^[a-z0-9_]{1,40}$/;
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
/** The cvar that would hand the bot's own RCON password to whoever reads the output. */
const FORBIDDEN_TOKEN = /\brcon_password\b/i;

type Json = Record<string, unknown>;

function obj(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FunctionError(`${what} must be an object.`);
  }
  return value as Json;
}

function str(
  value: unknown,
  what: string,
  max: number,
  { required = true } = {},
): string {
  if (typeof value !== 'string' || (required && !value.trim())) {
    throw new FunctionError(`${what} is required.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new FunctionError(`${what} is too long (up to ${max} characters).`);
  }
  return text;
}

function optionalNumber(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FunctionError(`${what} must be a number.`);
  }
  return value;
}

function token(value: unknown, what: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new FunctionError(
      `${what} must be one word: letters, digits and . : + - _ (up to 64).`,
    );
  }
  return value;
}

function options(
  value: unknown,
  what: string,
): { value: string; label: string }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OPTIONS) {
    throw new FunctionError(`${what} needs 1–${MAX_OPTIONS} options.`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const option = obj(entry, `${what} option`);
    const optionValue = token(option['value'], `${what} option value`);
    if (seen.has(optionValue)) {
      throw new FunctionError(`${what} lists "${optionValue}" twice.`);
    }
    seen.add(optionValue);
    return {
      value: optionValue,
      label: str(option['label'] ?? optionValue, `${what} option label`, 60),
    };
  });
}

function range(
  raw: Json,
  what: string,
): { min?: number; max?: number; integer?: boolean } {
  const min = optionalNumber(raw['min'], `${what} min`);
  const max = optionalNumber(raw['max'], `${what} max`);
  if (min !== undefined && max !== undefined && min > max) {
    throw new FunctionError(`${what}: min is above max.`);
  }
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(raw['integer'] === false ? { integer: false } : {}),
  };
}

function textLength(raw: Json, what: string): { maxLength?: number } {
  const length = optionalNumber(raw['maxLength'], `${what} maxLength`);
  if (length === undefined) {
    return {};
  }
  if (!Number.isInteger(length) || length < 1 || length > MAX_TEXT_LENGTH) {
    throw new FunctionError(`${what} maxLength must be 1–${MAX_TEXT_LENGTH}.`);
  }
  return { maxLength: length };
}

function parseParam(value: unknown): FunctionParam {
  const raw = obj(value, 'A parameter');
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  if (!PARAM_NAME.test(name)) {
    throw new FunctionError(
      `"${name}" is not a valid parameter name (lower case letters, digits, _; start with a letter).`,
    );
  }
  const label = str(raw['label'] ?? name, `Label of ${name}`, 40);
  const base = { name, label };
  const what = `Parameter ${name}`;
  switch (raw['type']) {
    case 'text':
      return { ...base, type: 'text', ...textLength(raw, what) };
    case 'number':
      return { ...base, type: 'number', ...range(raw, what) };
    case 'choice':
      return {
        ...base,
        type: 'choice',
        options: options(raw['options'], what),
      };
    case 'bool':
      return {
        ...base,
        type: 'bool',
        ...(raw['onValue'] !== undefined
          ? { onValue: token(raw['onValue'], `${what} onValue`) }
          : {}),
        ...(raw['offValue'] !== undefined
          ? { offValue: token(raw['offValue'], `${what} offValue`) }
          : {}),
      };
    case 'player':
      return { ...base, type: 'player' };
    case 'map':
      return { ...base, type: 'map' };
    default:
      throw new FunctionError(`${what} has an unknown type.`);
  }
}

function parseControl(value: unknown): SettingControl {
  const raw = obj(value, 'The control');
  switch (raw['type']) {
    case 'toggle':
      return {
        type: 'toggle',
        ...(raw['onValue'] !== undefined
          ? { onValue: token(raw['onValue'], 'onValue') }
          : {}),
        ...(raw['offValue'] !== undefined
          ? { offValue: token(raw['offValue'], 'offValue') }
          : {}),
      };
    case 'number':
      return { type: 'number', ...range(raw, 'The control') };
    case 'select':
      return {
        type: 'select',
        options: options(raw['options'], 'The control'),
      };
    case 'text':
      return { type: 'text', ...textLength(raw, 'The control') };
    default:
      throw new FunctionError('The control has an unknown type.');
  }
}

function parseStep(value: unknown, params: Map<string, FunctionParam>) {
  if (typeof value !== 'string') {
    throw new FunctionError('Each step must be text.');
  }
  const step = value.trim();
  if (!step) {
    throw new FunctionError('A step is empty.');
  }
  if (step.length > MAX_COMMAND_LENGTH) {
    throw new FunctionError(
      `A step is too long (up to ${MAX_COMMAND_LENGTH} characters).`,
    );
  }
  if (/[\r\n\0;]/.test(step)) {
    throw new FunctionError(
      'A step is one command: no line breaks or ";". Add another step instead.',
    );
  }
  if (FORBIDDEN_TOKEN.test(step)) {
    throw new FunctionError("Steps can't touch rcon_password.");
  }
  const used = new Set<string>();
  for (const [, name] of step.matchAll(PLACEHOLDER)) {
    const param = params.get(name ?? '');
    if (!param) {
      throw new FunctionError(`{${name}} in a step is not a parameter.`);
    }
    if (param.type === 'text' && step.includes(`"{${name}}"`)) {
      throw new FunctionError(
        `Text parameters are quoted for you: write {${name}}, not "{${name}}".`,
      );
    }
    used.add(param.name);
  }
  return { step, used };
}

/** What the request body must look like; throws `FunctionError` with a message for the owner. */
export function parseFunctionInput(
  body: unknown,
): Omit<SaveCustomFunctionInput, 'createdBy'> {
  const raw = obj(body, 'The request');
  const slug = typeof raw['slug'] === 'string' ? raw['slug'] : '';
  if (!SLUG.test(slug)) {
    throw new FunctionError(
      'The id must be lower case letters, digits and "-" (up to 40).',
    );
  }
  const kind = raw['kind'];
  if (kind !== 'action' && kind !== 'player_action' && kind !== 'setting') {
    throw new FunctionError('Pick a kind: action, player action or setting.');
  }
  const icon =
    typeof raw['icon'] === 'string' && raw['icon'].trim()
      ? raw['icon'].trim()
      : null;
  if (icon && !ICON.test(icon)) {
    throw new FunctionError('The icon must be a Material icon name.');
  }
  const requires =
    typeof raw['requires'] === 'string' && raw['requires']
      ? raw['requires']
      : null;
  if (
    requires &&
    (!isPermission(requires) || requires === 'functions.manage')
  ) {
    throw new FunctionError(`"${requires}" can't be required.`);
  }
  const serverAlias =
    typeof raw['serverAlias'] === 'string' && raw['serverAlias'].trim()
      ? raw['serverAlias'].trim()
      : null;
  return {
    slug,
    title: str(raw['title'], 'The title', 60),
    description:
      typeof raw['description'] === 'string' && raw['description'].trim()
        ? str(raw['description'], 'The description', 200)
        : null,
    icon,
    kind,
    definition: parseDefinition(kind, raw['definition']),
    serverAlias,
    requires,
    dangerous: raw['dangerous'] === true,
    enabled: raw['enabled'] !== false,
  };
}

/** Also run on every stored row before it can reach RCON — a hand-edited row is rejected here. */
export function parseDefinition(
  kind: CustomFunctionKind,
  value: unknown,
): CustomFunctionDefinition {
  const raw = obj(value, 'The definition');
  if (kind === 'setting') {
    const cvar = typeof raw['cvar'] === 'string' ? raw['cvar'] : '';
    if (!CVAR_NAME.test(cvar)) {
      throw new FunctionError("That's not a valid setting name.");
    }
    if (FORBIDDEN_TOKEN.test(cvar)) {
      throw new FunctionError("Settings can't touch rcon_password.");
    }
    return { cvar, control: parseControl(raw['control']) };
  }
  if (!Array.isArray(raw['params']) || raw['params'].length > MAX_PARAMS) {
    throw new FunctionError(`A function takes up to ${MAX_PARAMS} parameters.`);
  }
  const params = raw['params'].map(parseParam);
  const byName = new Map<string, FunctionParam>();
  for (const param of params) {
    if (byName.has(param.name)) {
      throw new FunctionError(`Parameter "${param.name}" is listed twice.`);
    }
    byName.set(param.name, param);
  }
  if (kind === 'player_action') {
    if (byName.has('player')) {
      throw new FunctionError(
        '"player" is filled in by the player menu; pick another parameter name.',
      );
    }
    byName.set('player', { name: 'player', label: 'Player', type: 'player' });
  }
  if (
    !Array.isArray(raw['steps']) ||
    raw['steps'].length < 1 ||
    raw['steps'].length > MAX_STEPS
  ) {
    throw new FunctionError(`A function has 1–${MAX_STEPS} steps.`);
  }
  const steps: string[] = [];
  const used = new Set<string>();
  for (const entry of raw['steps']) {
    const parsed = parseStep(entry, byName);
    steps.push(parsed.step);
    parsed.used.forEach((name) => used.add(name));
  }
  for (const param of params) {
    if (!used.has(param.name)) {
      throw new FunctionError(`Parameter "${param.name}" is never used.`);
    }
  }
  if (kind === 'player_action' && !used.has('player')) {
    throw new FunctionError('A player action must use {player} in a step.');
  }
  return { params, steps };
}

/**
 * A cvar's value out of the server's reply to its bare name, e.g. `"g_gravity" is:"800^7" default:"800^7"`
 * (the `^7` is the colour reset the game appends). `null` when the reply isn't that — an unset cvar.
 */
export function parseCvarReply(output: string, name: string): string | null {
  const first = output.split('\n').find((line) => line.trim()) ?? '';
  const match = /^"([^"]+)"\s+is:"(.*?)(?:\^7)?"(?:\s|,|$)/.exec(first.trim());
  if (!match || match[1]?.toLowerCase() !== name.toLowerCase()) {
    return null;
  }
  return match[2] ?? null;
}

/** What a run needs to know about the server — fetched only when the function uses it. */
export interface ResolveContext {
  players?: readonly { num: number; name: string }[];
  maps?: readonly string[];
}

/** Which live data `resolveSteps`/`resolveSetting` will ask for. */
export function needsContext(fn: Pick<CustomFunction, 'kind' | 'definition'>): {
  players: boolean;
  maps: boolean;
} {
  const { definition } = fn;
  if (!('params' in definition)) {
    return { players: false, maps: false };
  }
  return {
    // A player action's `{player}` is implicit, so it isn't among the parameters.
    players:
      fn.kind === 'player_action' ||
      definition.params.some((param) => param.type === 'player'),
    maps: definition.params.some((param) => param.type === 'map'),
  };
}

function numberValue(
  value: unknown,
  label: string,
  limits: { min?: number; max?: number; integer?: boolean },
): string {
  const parsed =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new FunctionError(`${label} must be a number.`);
  }
  if (limits.integer !== false && !Number.isInteger(parsed)) {
    throw new FunctionError(`${label} must be a whole number.`);
  }
  if (limits.min !== undefined && parsed < limits.min) {
    throw new FunctionError(`${label} must be at least ${limits.min}.`);
  }
  if (limits.max !== undefined && parsed > limits.max) {
    throw new FunctionError(`${label} must be at most ${limits.max}.`);
  }
  return String(parsed);
}

function textValue(value: unknown, label: string, maxLength?: number): string {
  const text =
    typeof value === 'string'
      ? sanitizeRconArg(value).slice(0, maxLength ?? DEFAULT_TEXT_LENGTH)
      : '';
  if (!text) {
    throw new FunctionError(`${label} is required.`);
  }
  return text;
}

function choiceValue(
  value: unknown,
  label: string,
  allowed: readonly { value: string }[],
): string {
  if (
    typeof value !== 'string' ||
    !allowed.some((option) => option.value === value)
  ) {
    throw new FunctionError(`${label}: pick one of the listed options.`);
  }
  return value;
}

function boolValue(value: unknown, label: string, on = '1', off = '0'): string {
  if (typeof value !== 'boolean') {
    throw new FunctionError(`${label} must be on or off.`);
  }
  return value ? on : off;
}

function paramValue(
  param: FunctionParam,
  value: unknown,
  context: ResolveContext,
): string {
  switch (param.type) {
    case 'text':
      return `"${textValue(value, param.label, param.maxLength)}"`;
    case 'number':
      return numberValue(value, param.label, param);
    case 'choice':
      return choiceValue(value, param.label, param.options);
    case 'bool':
      return boolValue(value, param.label, param.onValue, param.offValue);
    case 'player': {
      // The slot may have changed hands since the list was drawn: act only on the player seen.
      const pick = (typeof value === 'object' && value) as {
        num?: unknown;
        name?: unknown;
      };
      const player = context.players?.find(
        (candidate) =>
          candidate.num === pick.num && candidate.name === pick.name,
      );
      if (!player) {
        throw new FunctionError(
          `${param.label}: that player is no longer in that slot.`,
        );
      }
      return String(player.num);
    }
    case 'map':
      if (typeof value !== 'string' || !context.maps?.includes(value)) {
        throw new FunctionError(`${param.label}: pick an installed map.`);
      }
      return value;
  }
}

/** The commands to send, in order. Throws `FunctionError` before anything has been sent. */
export function resolveSteps(
  fn: Pick<CustomFunction, 'kind' | 'definition'>,
  values: unknown,
  context: ResolveContext = {},
): string[] {
  const definition = parseDefinition(fn.kind, fn.definition);
  if (!('steps' in definition)) {
    throw new FunctionError('This is a setting, not an action.');
  }
  const given =
    typeof values === 'object' && values !== null
      ? (values as Record<string, unknown>)
      : {};
  const params = new Map<string, FunctionParam>(
    definition.params.map((param) => [param.name, param]),
  );
  if (fn.kind === 'player_action') {
    params.set('player', { name: 'player', label: 'Player', type: 'player' });
  }
  const resolved = new Map<string, string>();
  for (const param of params.values()) {
    resolved.set(param.name, paramValue(param, given[param.name], context));
  }
  return definition.steps.map((step) => {
    const command = step.replace(
      PLACEHOLDER,
      (_match, name: string) => resolved.get(name) ?? '',
    );
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new FunctionError('The resulting command is too long.');
    }
    return command;
  });
}

/** The cvar and the value to set it to. */
export function resolveSetting(
  fn: Pick<CustomFunction, 'kind' | 'definition'>,
  value: unknown,
): { cvar: string; value: string } {
  const definition = parseDefinition(fn.kind, fn.definition);
  if (!('cvar' in definition)) {
    throw new FunctionError('This is not a setting.');
  }
  const { cvar, control } = definition;
  switch (control.type) {
    case 'toggle':
      return {
        cvar,
        value: boolValue(value, 'The value', control.onValue, control.offValue),
      };
    case 'number':
      return { cvar, value: numberValue(value, 'The value', control) };
    case 'select':
      return { cvar, value: choiceValue(value, 'The value', control.options) };
    case 'text':
      return {
        cvar,
        value: textValue(value, 'The value', control.maxLength),
      };
  }
}
