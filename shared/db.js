import postgres from "postgres";
import { config } from "./config.js";

let _sql = null;

export function getDb() {
  if (!_sql) {
    _sql = postgres(config.databaseUrl, { max: 10 });
  }
  return _sql;
}
