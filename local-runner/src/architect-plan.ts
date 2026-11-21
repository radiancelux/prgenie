/**
 * Adapted from pstack "Architect" (MIT, Copyright (c) 2026 Lauren Tan).
 * @see https://github.com/cursor/plugins/tree/main/pstack/skills/architect
 */
export const PSTACK_ARCHITECT_ATTRIBUTION =
  'Adapted from pstack "Architect" (MIT, Copyright (c) 2026 Lauren Tan).';

/** Agents must emit this heading with the plan before implementing (same pass). */
export const ARCHITECT_PLAN_HEADING = "ARCHITECT: PLAN";

export const CODE_ARCHITECT_PLAN_SECTION = `## Architect first (required)
Before you write or edit code, complete this planning phase in the same implementor pass (no separate stage or approval gate).

Trace every system this change touches. Sketch types, function signatures, and module boundaries. Prefer the shape where each piece of state has one owner, each task has one clear way to do it, and callers need to know the least. When the same workaround would repeat, redesign instead of stacking patches.

For mechanical or tiny tickets, a few lines are enough. When the design is non-obvious or contested, sketch two shapes and say why one wins.

Include a section in your message headed exactly:
${ARCHITECT_PLAN_HEADING}
Under it, write the plan. When you open or update the PR, also paste the same section into the PR body so reviewers see it.

After the plan, implement it.

${PSTACK_ARCHITECT_ATTRIBUTION}`;

export const DOCS_ARCHITECT_OUTLINE_SECTION = `## Outline first (required)
Before you draft or rewrite Markdown, complete this outline phase in the same implementor pass (no separate stage).

Note the sources you will use, target paths under the doc layout, and the section structure. Do not sketch types or code signatures — this is a documentation job.

For small updates, a few lines are enough. When structure or audience is non-obvious or contested, compare two outlines briefly and say why one wins.

Include a section in your message headed exactly:
${ARCHITECT_PLAN_HEADING}
Under it, write the outline. When you open or update the PR, also paste the same section into the PR body.

After the outline, write the docs.

${PSTACK_ARCHITECT_ATTRIBUTION}`;

/** True when a stage prompt embeds a default architect-first section (code or docs implement). */
export function promptIncludesArchitectPlanSection(prompt: string): boolean {
  return (
    prompt.includes(CODE_ARCHITECT_PLAN_SECTION) || prompt.includes(DOCS_ARCHITECT_OUTLINE_SECTION)
  );
}
