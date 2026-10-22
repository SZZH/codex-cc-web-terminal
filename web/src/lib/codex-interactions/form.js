const ROOT_KEYS = new Set(["$schema", "type", "properties", "required", "title", "description", "additionalProperties"]);
const FIELD_KEYS = new Set(["type", "title", "description", "default", "format", "minLength", "maxLength", "minimum", "maximum", "enum", "enumNames", "oneOf", "items", "minItems", "maxItems"]);
const FORM_MODES = new Set(["form", "openai/form", "openaiForm"]);

function optionsFor(schema) {
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
    return schema.enum.map((value, index) => ({ value, label: schema.enumNames?.[index] || value }));
  }
  const options = schema.oneOf || schema.anyOf;
  return Array.isArray(options) && options.every((option) => option && Object.keys(option).every((key) => ["const", "title"].includes(key)) && typeof option.const === "string" && typeof option.title === "string")
    ? options.map((option) => ({ value: option.const, label: option.title })) : null;
}
export function describeMcpForm(params = {}) {
  const schema = params.requestedSchema;
  if (!FORM_MODES.has(params.mode)) return { supported: false, fields: [], reason: "此交互不是网页表单。" };
  if (!schema || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties) ||
    schema.additionalProperties != null && schema.additionalProperties !== false ||
    ["$schema", "title", "description"].some((key) => schema[key] != null && typeof schema[key] !== "string") ||
    schema.required != null && (!Array.isArray(schema.required) || schema.required.some((id) => typeof id !== "string" || !Object.hasOwn(schema.properties, id))) ||
    Object.keys(schema).some((key) => !ROOT_KEYS.has(key))) return { supported: false, fields: [], reason: "此表单包含当前网页尚不支持的结构，请拒绝或取消后使用支持此表单的客户端。" };
  const fields = [];
  for (const [id, field] of Object.entries(schema.properties)) {
    if (!field || Object.keys(field).some((key) => !FIELD_KEYS.has(key)) || !["string", "number", "integer", "boolean", "array"].includes(field.type)) {
      return { supported: false, fields: [], reason: "此表单字段需要更多结构校验，当前网页无法确认。" };
    }
    const options = field.type === "array" ? optionsFor(field.items || {}) : optionsFor(field);
    if (field.type === "array" && (!options || Object.keys(field.items || {}).some((key) => !["type", "enum", "anyOf"].includes(key))) ||
      (field.enum || field.oneOf) && !options || field.format && !["email", "uri", "date", "date-time"].includes(field.format)) {
      return { supported: false, fields: [], reason: "此表单包含暂不支持的字段约束，当前网页无法确认。" };
    }
    if (options && !["string", "array"].includes(field.type)) return { supported: false, fields: [], reason: "此表单选项类型暂不支持，当前网页无法确认。" };
    fields.push({ ...field, id, label: field.title || id, required: schema.required?.includes(id) || false, options });
  }
  return { supported: true, fields, reason: "" };
}
export function initialMcpValues(fields) {
  return Object.fromEntries(fields.filter((field) => field.default != null || field.required &&
    (["boolean", "array"].includes(field.type) || field.type === "string" && !field.options))
    .map((field) => [field.id, field.default ?? (field.type === "boolean" ? false : field.type === "array" ? [] : "")]));
}
export function buildMcpFormResponse(fields, values) {
  const content = {};
  for (const field of fields) {
    let value = values[field.id];
    const missing = !Object.hasOwn(values, field.id) || value === undefined || value === null || field.type !== "string" && value === "";
    if (missing && field.required) throw new Error(`请填写“${field.label}”。`);
    if (missing) continue;
    if (["number", "integer"].includes(field.type)) {
      value = Number(value);
      if (!Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value) ||
        field.minimum != null && value < field.minimum || field.maximum != null && value > field.maximum) throw new Error(`“${field.label}”的数值不符合要求。`);
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`请选择“${field.label}”。`);
    } else if (field.type === "array") {
      if (!Array.isArray(value) || value.some((entry) => !field.options.some((option) => option.value === entry)) ||
        field.minItems != null && value.length < field.minItems || field.maxItems != null && value.length > field.maxItems) throw new Error(`“${field.label}”的选择数量不符合要求。`);
    } else {
      if (typeof value !== "string" || field.minLength != null && [...value].length < field.minLength ||
        field.maxLength != null && [...value].length > field.maxLength || field.options && !field.options.some((option) => option.value === value)) throw new Error(`“${field.label}”的内容不符合要求。`);
      if (field.format === "uri") { try { new URL(value); } catch { throw new Error(`“${field.label}”需要完整链接。`); } }
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`“${field.label}”需要有效邮箱。`);
      if (field.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(`“${field.label}”需要有效日期。`);
      if (field.format === "date-time") {
        if (!Number.isFinite(Date.parse(value))) throw new Error(`“${field.label}”需要有效时间。`);
        value = new Date(value).toISOString();
      }
    }
    Object.defineProperty(content, field.id, { value, enumerable: true, writable: true, configurable: true });
  }
  return { action: "accept", content };
}
