import { PrismaLibSql } from "@prisma/adapter-libsql";
import { config } from "../config";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaLibSql({ url: config.databaseUrl });

export const prisma = new PrismaClient({ adapter });
