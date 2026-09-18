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
  ExportGateReason,
  ExportGateSnapshot,
  ExportGateStatus,
  PreflightIssue,
  PreflightResult,
  WorktreeInfo,
} from "./types.js";
export { COMMENT_ROLES, COMMENT_STATUSES, STATUSES } from "./types.js";
export { GitError, findGitRoot, git, gitCommonDir, gitText, requireGitRoot } from "./git.js";
export {
  currentBranch,
  detectDefaultBase,
  listWorktrees,
  worktreeForBranch,
  ensureWorktreeForLoop,
  ensureLoopFeatureBranch,
  isBaseBranch,
  loopWorktreeIdentity,
  pruneArchivedLoopWorktree,
  releaseArchivedLoop,
  sameFsPath,
} from "./worktrees.js";
export type { ReleaseArchivedLoopResult } from "./worktrees.js";
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
  listenSentinel,
  listenWatchLane,
  parseDurationMs,
  resumeWatch,
  resumeWatchRole,
  formatWatchLane,
  formatWatchStatus,
  watchLane,
} from "./watch.js";
export type {
  ListenDoneReason,
  RepoWatchState,
  WatchHaltReason,
  WatchLaneState,
  WatchListenSentinel,
  WatchRole,
} from "./watch.js";
export { listenActivityFingerprint } from "./watchActivity.js";
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
  shouldEmitLegacyReviewerHandoff,
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
  exportLocalPr,
  exportPushRefspec,
  archiveLoopsMergedOnGithub,
  githubPrViewArgs,
} from "./export.js";
export type { GithubPrHeadState } from "./export.js";
export { evaluateAndStoreExportGate, validateExport } from "./export-validation.js";
export type { ExportValidationOptions, ExportValidationResult } from "./export-validation.js";
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
export { runCiChecks } from "./ci-runner.js";
export type { CiCheckResult, CiRunnerOptions, CiRunnerResult } from "./ci-runner.js";
export { clearCiCache, getCachedResult, recordCheckPass } from "./ci-cache.js";
export type { CiCacheEntry, CiCacheData } from "./ci-cache.js";
