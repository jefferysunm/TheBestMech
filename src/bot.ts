/** Entry point: speak mechfight/1 on stdin/stdout. */
import { run } from "./mechfight.ts"
import { Brain } from "./brain.ts"

run((hello) => new Brain(hello))
