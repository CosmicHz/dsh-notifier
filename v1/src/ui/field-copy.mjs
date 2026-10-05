// Field copy and control metadata for the editor (15-FIELD-COPY.md, spec/EDITOR-FIELDS.json).
// Copy comes only from the frozen machine fields: label/help/placeholder/errorRequired
// exist in both zh and en, with no invented strings.
import { editorFields, fieldsFor, fieldVisible, fieldRequired } from '../domain/descriptors.mjs';

export const LOCALES = Object.freeze(['zh', 'en']);
export const DEFAULT_LOCALE = 'zh';

const FIELD_BY_ID = new Map(editorFields.map((f) => [f.id, f]));

export function fieldById(id) {
  return FIELD_BY_ID.get(id) ?? null;
}

export function normalizeLocale(locale) {
  return LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
}

export function fieldCopy(field, locale = DEFAULT_LOCALE) {
  const loc = normalizeLocale(locale);
  const copy = field?.[loc] ?? field?.[DEFAULT_LOCALE] ?? {};
  return {
    label: copy.label ?? '',
    help: copy.help ?? '',
    placeholder: copy.placeholder ?? '',
    errorRequired: copy.errorRequired ?? copy.label ?? '',
  };
}

export function labelFor(field, locale) {
  return fieldCopy(field, locale).label;
}

export function helpFor(field, locale) {
  return fieldCopy(field, locale).help;
}

/** Control metadata the renderer needs; never includes secret values. */
export function controlFor(field) {
  return {
    id: field.id,
    field: field.field,
    path: field.path,
    type: field.type,
    control: field.control,
    exposure: field.exposure,
    owner: field.owner,
    required: field.required === true,
    advanced: field.advanced === true,
    default: field.default ?? null,
    enum: field.enum ? [...field.enum] : null,
    minimum: field.minimum ?? null,
    maximum: field.maximum ?? null,
  };
}

export function controlsFor(channelId, direction, owner, { locale, context = {} } = {}) {
  return fieldsFor(channelId, direction, owner)
    .filter((f) => fieldVisible(f, context))
    .map((f) => ({
      ...controlFor(f),
      required: fieldRequired(f, context),
      copy: fieldCopy(f, locale),
    }));
}

const ERROR_CODE_COPY = Object.freeze({
  REQUIRED: { zh: '此项为必填。', en: 'This field is required.' },
  TYPE: { zh: '格式不正确。', en: 'Wrong format.' },
  RANGE: { zh: '数值超出允许范围。', en: 'Value is out of range.' },
  ENUM: { zh: '请选择一个允许的取值。', en: 'Choose an allowed value.' },
  SECRET_MASKED: { zh: '不能把掩码当作新值保存。', en: 'A masked value cannot be saved as a secret.' },
  UNKNOWN: { zh: '无法保存，请检查该项。', en: 'Could not save; check this field.' },
});

/** Localized validation message for a field problem. */
export function errorMessage(field, locale, code = 'UNKNOWN') {
  const loc = normalizeLocale(locale);
  if (code === 'REQUIRED' && field) {
    const copy = fieldCopy(field, loc);
    if (copy.errorRequired) return copy.errorRequired;
  }
  return (ERROR_CODE_COPY[code] ?? ERROR_CODE_COPY.UNKNOWN)[loc];
}

/**
 * Map a descriptor problem string ("field: reason") to localized copy.
 * Returns the raw problem when it cannot be classified, so nothing is hidden.
 */
export function describeProblem(channelId, direction, owner, problem, locale = DEFAULT_LOCALE) {
  const [fieldName, ...rest] = String(problem).split(':');
  const reason = rest.join(':').trim();
  const field = fieldsFor(channelId, direction, owner).find((f) => f.field === fieldName.trim() || f.path === fieldName.trim());
  let code = 'UNKNOWN';
  if (/required/.test(reason)) code = 'REQUIRED';
  else if (/expected/.test(reason)) code = 'TYPE';
  else if (/must be/.test(reason)) code = 'RANGE';
  else if (/not allowed|unknown/.test(reason)) code = 'ENUM';
  if (!field) return { field: fieldName.trim(), code, message: problem };
  return {
    field: field.field,
    path: field.path,
    code,
    message: code === 'UNKNOWN' ? problem : errorMessage(field, locale, code),
  };
}