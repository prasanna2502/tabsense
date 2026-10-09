/**
 * Branding — the ONLY place in the codebase where the product name lives.
 *
 * The name was chosen while several unrelated projects already use it
 * (see docs/proposal.md). If real pushback materializes (store review,
 * trademark claim, community confusion), renaming is a one-place change
 * here, never a refactor.
 */
export const BRANDING = {
  productName: 'TabSense',
  tagline: 'Automatic semantic tab groups for Chrome',
} as const;
