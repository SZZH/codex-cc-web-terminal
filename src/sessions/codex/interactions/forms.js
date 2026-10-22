import { dangerousKey, fields, invalid, object } from "./validation.js";

const base = ["type", "title", "description", "default"];
const formats = new Set(["email", "uri", "date", "date-time"]);
const stringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const hasOnly = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));

function choices(schema) {
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((entry) => entry.const);
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((entry) => entry.const);
  return null;
}

function validChoices(schema) {
  if (["enum", "oneOf", "anyOf"].filter((key) => schema[key] != null).length !== 1) return false;
  const values = choices(schema);
  if (!stringList(values) || !values.length || new Set(values).size !== values.length) return false;
  for (const key of ["oneOf", "anyOf"]) if (schema[key] && !schema[key].every((entry) =>
    hasOnly(entry, ["const", "title"]) && typeof entry.const === "string" && typeof entry.title === "string")) return false;
  return !schema.enumNames || stringList(schema.enumNames) && schema.enumNames.length === values.length;
}

function supportedField(schema) {
  if (!object(schema)) return false;
  if (["title", "description"].some((key) => schema[key] != null && typeof schema[key] !== "string")) return false;
  if (["string"].includes(schema.type)) {
    if (!hasOnly(schema, [...base, "enum", "enumNames", "oneOf", "format", "minLength", "maxLength"])) return false;
    if ((schema.enum || schema.oneOf || schema.enumNames) && !validChoices(schema)) return false;
    if (schema.format != null && !formats.has(schema.format)) return false;
    return ["minLength", "maxLength"].every((key) => schema[key] == null || Number.isSafeInteger(schema[key]) && schema[key] >= 0);
  }
  if (["number", "integer"].includes(schema.type)) return hasOnly(schema, [...base, "minimum", "maximum"])
    && ["minimum", "maximum"].every((key) => schema[key] == null || Number.isFinite(schema[key]));
  if (schema.type === "boolean") return hasOnly(schema, base);
  if (schema.type === "array") return hasOnly(schema, [...base, "items", "minItems", "maxItems"])
    && hasOnly(schema.items, ["type", "enum", "anyOf"]) && (schema.items.type == null || schema.items.type === "string") && validChoices(schema.items)
    && ["minItems", "maxItems"].every((key) => schema[key] == null || Number.isSafeInteger(schema[key]) && schema[key] >= 0);
  return false;
}

/** The typed MCP form schema has a deliberately bounded set of primitive fields. */
export function formSupport(schema) {
  if (!hasOnly(schema, ["$schema", "type", "properties", "required", "title", "description", "additionalProperties"]) || schema.type !== "object" || !object(schema.properties)
    || schema.additionalProperties != null && schema.additionalProperties !== false
    || ["$schema", "title", "description"].some((key) => schema[key] != null && typeof schema[key] !== "string")) return "This form schema requires additional schema validation support.";
  if (schema.required != null && (!stringList(schema.required) || schema.required.some((name) => !Object.hasOwn(schema.properties, name)))) return "The form has invalid required fields.";
  for (const [name, field] of Object.entries(schema.properties)) if (dangerousKey(name) || !supportedField(field)) return "This form contains an unsupported field schema.";
  return null;
}

function validFormat(value, format) {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") { try { return Boolean(new URL(value).protocol); } catch { return false; } }
  if (format === "date") {
    const date = new Date(`${value}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  if (format === "date-time") {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
    return Boolean(match && validFormat(match[1], "date") && Number(match[2]) <= 23 && Number(match[3]) <= 59
      && Number(match[4]) <= 60 && Number(match[5] || 0) <= 23 && Number(match[6] || 0) <= 59);
  }
  return true;
}

function validateField(schema, value) {
  if (schema.type === "string") {
    if (typeof value !== "string" || schema.minLength != null && [...value].length < schema.minLength || schema.maxLength != null && [...value].length > schema.maxLength) return false;
    const options = choices(schema);
    return (!options || options.includes(value)) && (!schema.format || validFormat(value, schema.format));
  }
  if (["number", "integer"].includes(schema.type)) return typeof value === "number" && Number.isFinite(value)
    && (schema.type !== "integer" || Number.isInteger(value)) && (schema.minimum == null || value >= schema.minimum) && (schema.maximum == null || value <= schema.maximum);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "array") {
    const allowed = new Set(choices(schema.items));
    return stringList(value) && new Set(value).size === value.length && value.every((entry) => allowed.has(entry))
      && (schema.minItems == null || value.length >= schema.minItems) && (schema.maxItems == null || value.length <= schema.maxItems);
  }
  return false;
}

export function validateForm(schema, content) {
  if (formSupport(schema)) throw invalid("Unsupported form schema", "unsupported_interaction_schema");
  fields(content, Object.keys(schema.properties), "Invalid form fields");
  for (const key of schema.required || []) if (!Object.hasOwn(content, key)) throw invalid("A required form field is missing");
  for (const [name, value] of Object.entries(content)) if (!validateField(schema.properties[name], value)) throw invalid("Invalid form field value or constraint");
}
