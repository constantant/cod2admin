/**
 * Conventional Commits are required so `nx release` (nx.json `release.version.conventionalCommits`)
 * can infer version bumps and categorize the generated CHANGELOG.md automatically.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
};
