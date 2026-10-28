#!/usr/bin/env node
/**
 * grpc-encode.js — кодирует JSON-аргументы в protobuf.
 *
 * Два режима:
 *
 * 1) grpcurl-режим (рекомендуется):
 *    grpc-encode.js --proto <dir|file> --method <Service/Method> --args '<json>'
 *    → на stdout выводится JSON, готовый для `grpcurl -d`.
 *      Поля TypedMessage / google.protobuf.Any с bytes `value` автоматически
 *      кодируются: если value — вложенный объект, он рекурсивно кодируется
 *      как тип, указанный в sibling-поле `type` (или `type_url`),
 *      и результат подставляется как base64-строка.
 *
 * 2) raw-режим:
 *    grpc-encode.js --proto <dir|file> --type <Full.Message.Type> \
 *                    --args '<json>' --format base64
 *    → на stdout выводится base64 от закодированного сообщения.
 *
 * Общие опции:
 *    --include <dir>   дополнительный путь для import-резолвинга (можно повторять)
 */

const fs = require("fs");
const path = require("path");
const protobuf = require("protobufjs");

// ---------- CLI ----------

function parseCli(argv) {
  const out = { includes: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--proto") out.proto = argv[++i];
    else if (a === "--include") out.includes.push(argv[++i]);
    else if (a === "--method") out.method = argv[++i];
    else if (a === "--type") out.type = argv[++i];
    else if (a === "--args") out.args = argv[++i];
    else if (a === "--format") out.format = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

// ---------- Загрузка .proto ----------

function listProtoFiles(input) {
  const st = fs.statSync(input);
  if (st.isFile()) return [path.resolve(input)];
  const out = [];
  for (const e of fs.readdirSync(input)) {
    const full = path.join(input, e);
    if (fs.statSync(full).isDirectory()) out.push(...listProtoFiles(full));
    else if (e.endsWith(".proto")) out.push(path.resolve(full));
  }
  return out;
}

function makeResolver(protoFiles, includes) {
  const dirs = new Set();
  for (const f of protoFiles) dirs.add(path.dirname(f));
  for (const d of includes) dirs.add(path.resolve(d));

  return (origin, target) => {
    if (origin) {
      const p = path.resolve(path.dirname(origin), target);
      if (fs.existsSync(p)) return p;
    }
    for (const d of dirs) {
      const p = path.resolve(d, target);
      if (fs.existsSync(p)) return p;
    }
    return target; // пусть protobufjs сам поищет в дефолтных местах
  };
}

// ---------- Препроцессинг TypedMessage / Any ----------

function findField(type, ...names) {
  for (const n of names) if (type.fields[n]) return type.fields[n];
  return null;
}

function preprocess(value, type, root) {
  if (value === null || value === undefined) return value;
  if (!type || !type.fields) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value; // расширим позже при необходимости

  const typeField = findField(type, "type", "type_url", "typeUrl");
  const valueField = findField(type, "value");

  // Детект TypedMessage / google.protobuf.Any
  if (
    typeField &&
    valueField &&
    typeField.type === "string" &&
    valueField.type === "bytes" &&
    typeof value[typeField.name] === "string" &&
    value[valueField.name] !== null &&
    typeof value[valueField.name] === "object"
  ) {
    let innerTypeName = value[typeField.name];
    // для Any: "type.googleapis.com/foo.Bar" → "foo.Bar"
    if (innerTypeName.includes("/"))
      innerTypeName = innerTypeName.split("/").pop();

    let InnerType;
    try {
      InnerType = root.lookupType(innerTypeName);
    } catch {
      throw new Error(
        `Не могу найти вложенный тип "${innerTypeName}" ` +
          `(объявлен в "${type.fullName}.${typeField.name}"). ` +
          `Проверьте, что .proto с этим типом попадает в --proto/--include.`,
      );
    }

    const innerBuf = encodeMessage(value[valueField.name], InnerType, root);
    return { ...value, [valueField.name]: innerBuf.toString("base64") };
  }

  // Рекурсия по message-полям
  const out = {};
  for (const key of Object.keys(value)) {
    const f = type.fields[key];
    if (f && f.resolvedType instanceof protobuf.Type) {
      out[key] = preprocess(value[key], f.resolvedType, root);
    } else {
      out[key] = value[key];
    }
  }
  return out;
}

function encodeMessage(jsonValue, Type, root) {
  const processed = preprocess(jsonValue, Type, root);
  const err = Type.verify(processed);
  if (err) {
    throw new Error(
      `verify failed для ${Type.fullName}: ${err}\n` +
        `Вход после препроцессинга:\n${JSON.stringify(processed, null, 2)}`,
    );
  }
  return Type.encode(Type.fromObject(processed)).finish();
}

// ---------- main ----------

async function main() {
  const cli = parseCli(process.argv);
  if (!cli.proto) throw new Error("Missing --proto <dir-or-file>");
  if (!cli.args) throw new Error("Missing --args '<json>'");
  if (!cli.method && !cli.type) throw new Error("Provide --method or --type");

  const protoFiles = listProtoFiles(cli.proto);
  if (protoFiles.length === 0) throw new Error(`Нет .proto в ${cli.proto}`);

  const root = new protobuf.Root();
  root.resolvePath = makeResolver(protoFiles, cli.includes);
  await root.load(protoFiles);
  root.resolveAll();

  let jsonArgs;
  try {
    jsonArgs = JSON.parse(cli.args);
  } catch (e) {
    throw new Error(`Некорректный --args JSON: ${e.message}`);
  }

  let Type;
  if (cli.method) {
    const slash = cli.method.lastIndexOf("/");
    if (slash === -1) throw new Error('--method должен быть "Service/Method"');
    const svcName = cli.method.slice(0, slash);
    const methodName = cli.method.slice(slash + 1);
    const Svc = root.lookupService(svcName);
    const m = Svc.methods[methodName];
    if (!m)
      throw new Error(`Метод "${methodName}" не найден в сервисе "${svcName}"`);
    Type = root.lookupType(m.requestType);
  } else {
    Type = root.lookupType(cli.type);
  }

  const buf = encodeMessage(jsonArgs, Type, root);
  const format = cli.format || (cli.method ? "json" : "base64");

  if (format === "base64") {
    process.stdout.write(buf.toString("base64") + "\n");
  } else if (format === "json") {
    const msg = Type.decode(buf);
    const obj = Type.toObject(msg, {
      longs: String,
      enums: String,
      bytes: String, // bytes → base64 в JSON
      defaults: false,
      arrays: true,
      objects: true,
    });
    process.stdout.write(JSON.stringify(obj) + "\n");
  } else {
    throw new Error(`Неизвестный --format "${format}"`);
  }
}

main().catch((err) => {
  process.stderr.write(`grpc-encode: ${err.message}\n`);
  process.exit(1);
});
