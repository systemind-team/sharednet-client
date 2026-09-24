#!/usr/bin/env node

import { main } from "../dist/main.js";

process.exitCode = await main();
