export type {
  CaptureResult,
  CommentRole,
  CommentStatus,
  CommentThread,
  CreateLocalPrInput,
  Learning,
  LocalPr,
  LocalPrComment,
  LocalPrSource,
  LocalPrStatus,
  ExportGateCheck,
  ExportGateCiCheck,
  ExportGateCiPlan,
  ExportGateReason,
  ExportGateSnapshot,
  ExportGateStatus,
  PreflightIssue,
  PreflightResult,
  WorktreeInfo,
} from "./types.js";
export { COMMENT_ROLES, COMMENT_STATUSES, STATUSES } from "./types.js";
export {
  GitBinaryError,
  GitError,
  PRGENIE_GIT_ENV,
  clearGitBinaryCache,
  findGitRoot,
  formatGitMissingError,
  formatGitSpawnError,
  git,
  gitCommonDir,
  gitText,
  requireGitBinary,
  requireGitRoot,
  resolveGitBinary,
  windowsGitCandidates,
} from "./git.js";
export { mcpCwdCandidates, resolveMcpGitRoot } from "./mcp-cwd.js";
export {
  currentBranch,
  detectDefaultBase,
  listWorktrees,
  worktreeForBranch,
  ensureWorktreeForLoop,
  ensureLoopFeatureBranch,
  findPeelStashRef,
  isBaseBranch,
  loopWorktreeIdentity,
  peelStashMessage,
  pruneArchivedLoopWorktree,
  pruneLoopWorktrees,
  refusePrimaryWorktreeIfParallel,
  releaseArchivedLoop,
  sameFsPath,
} from "./worktrees.js";
export type { ReleaseArchivedLoopResult } from "./worktrees.js";
export {
  assertNoDirtyPluginBuildArtifacts,
  dirtyPluginDoctorFix,
  formatDirtyPluginBuildArtifactsError,
  isPluginBuildArtifact,
  listDirtyPluginBuildArtifacts,
} from "./plugin-dirt.js";
export {
  addLocalPrComment,
  addressLocalPrComment,
  addressedReviewComments,
  attachLocalPr,
  captureAgentWork,
  commentThreads,
  completeLocalPrReview,
  createLocalPr,
  deleteLocalPr,
  deleteLocalPrComment,
  editLocalPrComment,
  findLocalPrForCurrentBranch,
  findLocalPrForCurrentWorktree,
  formatReviewInbox,
  formatSpawnReviewer,
  getLocalPr,
  getLocalPrDiff,
  getLocalPrNameStatus,
  hasCommitsAheadOfBase,
  isArchivedPr,
  isFindingComment,
  isReviewRequestBody,
  listCorruptLocalPrFiles,
  listLocalPrs,
  localPrMatchesSearch,
  normalizeLocalPrSearchFields,
  markReviewRequested,
  markReviewerNotified,
  normalizeComment,
  pendingReviewComments,
  refreshLocalPrHead,
  reopenLocalPr,
  resolveLocalPrComment,
  resumeWatchForNextLoop,
  setLocalPrExportGate,
  setLocalPrStatus,
  shouldSpawnReviewer,
  updateLocalPr,
} from "./prs.js";
export type {
  CompleteLocalPrReviewResult,
  ListLocalPrsOptions,
  LocalPrSearchField,
  AttachLocalPrInput,
} from "./prs.js";
export {
  haltWatch,
  haltWatchRole,
  getRepoWatch,
  resumeWatch,
  resumeWatchRole,
  formatWatchLane,
  formatWatchStatus,
  watchLane,
  LISTEN_REMOVED_MESSAGE,
} from "./watch.js";
export type { RepoWatchState, WatchHaltReason, WatchLaneState, WatchRole } from "./watch.js";
export {
  claimReview,
  formatClaimReview,
  getReviewClaim,
  listReviewClaims,
  reviewClaimKey,
} from "./review-claim.js";
export type { ClaimReviewReason, ClaimReviewResult, ReviewClaim } from "./review-claim.js";
export {
  bindSteward,
  clearStewardBinding,
  decideStewardAction,
  formatStewardBinding,
  formatStewardDecision,
  getStewardBinding,
  isStewardOwned,
  listStewardBindings,
  stewardNext,
} from "./steward.js";
export type {
  BindStewardInput,
  StewardActionKind,
  StewardBinding,
  StewardDecision,
  StewardNextOptions,
  StewardNextResult,
} from "./steward.js";
export { formatDoctorReport, runDoctor } from "./doctor.js";
export type { DoctorReport, DoctorCheck } from "./doctor.js";
export {
  PRGENIE_MCP_NAME,
  argHasUnresolvedPluginRoot,
  bufferHasUtf8Bom,
  inspectMcpJson,
  parseMcpJson,
  pinPluginMcpJson,
  sameNameCollision,
  stripBom,
  windowsStdioSpawn,
} from "./plugin-mcp.js";
export type { McpFile, McpJsonInspection, McpServerEntry } from "./plugin-mcp.js";
export {
  exportLocalPr,
  exportPushRefspec,
  archiveLoopsMergedOnGithub,
  githubPrViewArgs,
} from "./export.js";
export type { GithubPrHeadState } from "./export.js";
export {
  abortExportGate,
  evaluateAndStoreExportGate,
  exportGateInFlight,
  validateExport,
} from "./export-validation.js";
export {
  acquireCiLock,
  ciAbortFile,
  pidAlive,
  readCiAbortSeq,
  requestCiAbort,
  watchCiAbort,
} from "./ci-abort.js";
export type { ExportValidationOptions, ExportValidationResult } from "./export-validation.js";
export {
  abortError,
  ciCheckCommand,
  applyCiProgressEvent,
  createProgressCardSink,
  emptyCiProgressSnapshot,
  formatElapsed,
  formatFailedCheck,
  formatProgressCard,
  formatProgressLine,
  formatProgressStep,
  isAbortError,
  shortCheckName,
  throwIfAborted,
} from "./progress.js";
export type {
  CiCheckProgress,
  CiCheckProgressState,
  CiProgressSnapshot,
  ProgressCallback,
  ProgressEvent,
  ProgressKind,
  ProgressPhase,
  ProgressState,
  RunProgressOptions,
} from "./progress.js";
export {
  displayShepherdStatus,
  exportGateForHead,
  exportReadyEnterKey,
  formatExportBlockLabel,
  HUMAN_EXPORT_COMPOSER_HINT,
  HUMAN_EXPORT_DISMISS_ACTION,
  HUMAN_EXPORT_HINT,
  HUMAN_EXPORT_PRIMARY_ACTION,
  HUMAN_EXPORT_STATUS_LABEL,
  humanExportConfirmMessage,
  humanExportEnterMessage,
  humanExportState,
  humanExportUi,
  isHumanExportable,
  needsExportGateEvaluation,
  nextExportReadyEnter,
  normalizeExportGate,
  pendingExportGate,
  retainExportReadyNotified,
} from "./export-gate.js";
export type { HumanExportKind, HumanExportState, HumanExportUi } from "./export-gate.js";
export { appendSession, formatSessionEvent, listSessions } from "./sessions.js";
export type { ListSessionsOptions, SessionEvent } from "./sessions.js";
export { generateLearningDigest, formatLearningDigest } from "./learning.js";
export type { LearningSummary } from "./learning.js";
export { consoleDir, parseJsonObject, writeJsonFile } from "./store.js";
export { parseGhAuthStatus } from "./github.js";
export type { GhAccount, RepoGithubBind } from "./github.js";
export {
  activeGhLogin,
  bindRepoGithub,
  ensureRepoGithub,
  getRepoGithubBind,
  listGhAccounts,
  switchGhUser,
} from "./github-ops.js";
export {
  checkReleaseVersions,
  collectPackageVersions,
  collectVsixArtifacts,
  findPackageRoot,
  versionFromVsixFileName,
} from "./versions.js";
export type {
  CollectPackageVersionsResult,
  PackageVersionEntry,
  ReleaseVersionReport,
  VsixArtifactInfo,
} from "./versions.js";
export {
  addLearnings,
  deleteLearning,
  disableLearning,
  enableLearning,
  extractLearningsFromResolvedComments,
  getLearning,
  listLearnings,
  runPreflight,
} from "./learnings.js";
export { shepherdStatus } from "./shepherd.js";
export type {
  ShepherdBlockReason,
  ShepherdOptions,
  ShepherdResult,
  ShepherdStatus,
} from "./shepherd.js";
export { runCiChecks, runLoopCi } from "./ci-runner.js";
export type { CiCheckResult, CiRunnerOptions, CiRunnerResult, LoopCiOptions } from "./ci-runner.js";
export {
  changedPathsForCi,
  classifyCiPath,
  DEFAULT_CI_CHECKS,
  envFlag,
  formatCiSelectionReason,
  isPackageScopedCheck,
  isScopablePackage,
  packageFromCiPath,
  packageFromScopedCheck,
  resolveCiCwd,
  SCOPABLE_PACKAGES,
  selectCiChecks,
} from "./ci-select.js";
export type { CiCheckMapping, CiCheckSelection, CiPathKind, ScopablePackage } from "./ci-select.js";
export {
  collectExecOutput,
  formatCiCheckError,
  formatFailureExcerpt,
  latestCiFailure,
  listCiFailureLogs,
  parseFirstFailingTest,
  parseGateExcerpt,
  readCiFailureLog,
  writeCiFailureLog,
} from "./ci-failure.js";
export type { CiFailureLogMeta, ExecFailureOutput } from "./ci-failure.js";
export { clearCiCache, getCachedResult, recordCheckPass } from "./ci-cache.js";
export type { CiCacheEntry, CiCacheData } from "./ci-cache.js";
