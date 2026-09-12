#!/usr/bin/env node
// Create the Airlock demo issue graph in YOUR Linear workspace (opt-in; writes 5 issues + 2 relations).
//   node --env-file=.env bin/linear-seed.js [TEAM_KEY]
const key = process.env.LINEAR_API_KEY;
if (!key) { console.error('LINEAR_API_KEY is not set.'); process.exit(1); }
const gql = async (query, variables = {}) => {
  const r = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map(e => e.message).join('; '));
  return j.data;
};
const create = async input => {
  const d = await gql('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', { input });
  if (!d.issueCreate.success) throw new Error('issueCreate failed');
  console.log(`  created ${d.issueCreate.issue.identifier}  ${input.title}`);
  return d.issueCreate.issue;
};
const relate = async (issueId, relatedIssueId, type) => {
  const d = await gql('mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }', { input: { issueId, relatedIssueId, type } });
  if (!d.issueRelationCreate.success) throw new Error('issueRelationCreate failed');
};
try {
  const { teams } = await gql('{ teams { nodes { id key name } } }');
  const wanted = process.argv[2];
  const team = wanted ? teams.nodes.find(t => t.key === wanted) : teams.nodes[0];
  if (!team) throw new Error(`Team ${wanted || ''} not found. Teams: ${teams.nodes.map(t => t.key).join(', ')}`);
  console.log(`Seeding demo graph in team ${team.key} (${team.name})`);
  const parent = await create({ teamId: team.id, title: 'Enterprise SSO rollout', description: 'Project decision thread for authentication and session storage.' });
  const policy = await create({ teamId: team.id, title: 'Security policy: token storage', description: 'Refresh tokens may be persisted only when encrypted at rest with the KMS-managed key.' });
  const contract = await create({ teamId: team.id, title: 'Session API contract', description: 'POST /auth/session returns { user_id, token }. Consumers treat token as opaque.', parentId: parent.id });
  const task = await create({ teamId: team.id, title: 'Persist OAuth refresh tokens', description: 'Store OAuth refresh tokens in Postgres so users remain signed in. Touch auth/session and database/tokens.', parentId: parent.id });
  await create({ teamId: team.id, title: 'Build enterprise login UI', description: 'Use the session API for the login UI. Touch frontend/login.', parentId: parent.id });
  await relate(policy.id, task.id, 'related');   // policy is a constraint source for the task
  await relate(contract.id, task.id, 'blocks');  // contract is a dependency of the task
  console.log(`\nDone. Import ${task.identifier} in the Airlock UI. Then post a comment on ${policy.identifier} such as:`);
  console.log('  "Security review complete: refresh tokens must never be persisted. Use session cookies only."');
  console.log(`Task: ${task.url}`);
} catch (error) { console.error(`Linear error: ${error.message}`); process.exit(1); }
