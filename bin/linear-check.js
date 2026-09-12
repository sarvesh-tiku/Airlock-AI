#!/usr/bin/env node
// Verify LINEAR_API_KEY and show the teams and a few recent issues you can import.
//   node --env-file=.env bin/linear-check.js
const key = process.env.LINEAR_API_KEY;
if (!key) { console.error('LINEAR_API_KEY is not set. Copy .env.example to .env and add your personal API key.'); process.exit(1); }
const gql = async (query, variables = {}) => {
  const r = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map(e => e.message).join('; '));
  return j.data;
};
try {
  const { viewer, teams } = await gql('{ viewer { name email } teams { nodes { id key name } } }');
  console.log(`Authenticated as ${viewer.name} <${viewer.email}>`);
  for (const t of teams.nodes) console.log(`  team ${t.key}  ${t.name}  id=${t.id}`);
  const { issues } = await gql('{ issues(first: 10, orderBy: updatedAt) { nodes { identifier title parent { identifier } } } }');
  console.log('Recent issues you can import:');
  for (const i of issues.nodes) console.log(`  ${i.identifier}  ${i.title}${i.parent ? `  (parent ${i.parent.identifier})` : ''}`);
  if (!issues.nodes.length) console.log('  (none yet: run  node --env-file=.env bin/linear-seed.js  to create the demo graph)');
} catch (error) { console.error(`Linear error: ${error.message}`); process.exit(1); }
