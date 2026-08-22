/** Cross-platform consistency — group same-intent runs across harnesses. */
export {
  groupPlatformRuns,
  runFromBundle,
  consistencyKey,
  registerPlatformAdapter,
  type ConsistencyGroup,
  type PlatformRun,
} from "./platform.js";