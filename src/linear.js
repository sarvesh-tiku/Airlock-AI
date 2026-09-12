const endpoint = 'https://api.linear.app/graphql';

async function query(document, variables = {}) {
  if (!process.env.LINEAR_API_KEY) throw new Error('LINEAR_API_KEY is not configured');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: process.env.LINEAR_API_KEY },
    body: JSON.stringify({ query: document, variables }), signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(`Linear: ${json.errors.map(e => e.message).join('; ')}`);
  return json.data;
}

const ISSUE = `query AirlockIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url createdAt updatedAt
    creator { name }
    parent { id identifier }
    relations(first: 25) { nodes { type relatedIssue { id identifier } } }
    inverseRelations(first: 25) { nodes { type issue { id identifier } } }
    comments(first: 50) { nodes { id body createdAt updatedAt user { name } } }
  }
}`;

// Watch set from Linear's graph: the parent, issues that block this one
// (dependencies), and issues marked related (treated as constraint sources).
function normalize(issue) {
  const relations = [];
  for (const r of issue.inverseRelations?.nodes || []) {
    if (r.type === 'blocks' && r.issue) relations.push({ type: 'dependsOn', issueId: r.issue.identifier, linearId: r.issue.id });
    if (r.type === 'related' && r.issue) relations.push({ type: 'constrainedBy', issueId: r.issue.identifier, linearId: r.issue.id });
  }
  for (const r of issue.relations?.nodes || []) {
    if (r.type === 'related' && r.relatedIssue) relations.push({ type: 'constrainedBy', issueId: r.relatedIssue.identifier, linearId: r.relatedIssue.id });
  }
  return {
    id: issue.identifier, linearId: issue.id, url: issue.url,
    title: issue.title, description: issue.description || '', parentId: issue.parent?.identifier || null,
    creator: issue.creator?.name || null, updatedAt: issue.updatedAt || issue.createdAt, relations,
    comments: issue.comments.nodes.map(c => ({ id: c.id, body: c.body, author: c.user?.name || 'Unknown', at: c.updatedAt || c.createdAt }))
  };
}

export async function fetchIssueGraph(identifier) {
  const root = (await query(ISSUE, { id: identifier })).issue;
  if (!root) throw new Error(`Linear issue ${identifier} not found`);
  const normalized = normalize(root);
  const issues = [normalized];
  const wanted = [root.parent?.id, ...normalized.relations.map(r => r.linearId)].filter(Boolean).slice(0, 8);
  for (const id of [...new Set(wanted)]) {
    const issue = (await query(ISSUE, { id })).issue;
    if (issue) issues.push(normalize(issue));
  }
  return issues;
}

export async function refreshGraph(issues) {
  const ids = [...new Set(issues.map(i => i.linearId).filter(Boolean))];
  const result = [];
  for (const id of ids) {
    const issue = (await query(ISSUE, { id })).issue;
    if (!issue) throw new Error(`Watched Linear issue ${id} disappeared`);
    result.push(normalize(issue));
  }
  return result;
}

export async function publishIntervention(issue, message) {
  const data = await query(`mutation AirlockComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`, {
    input: { issueId: issue.linearId, body: message }
  });
  if (!data.commentCreate?.success) throw new Error('Linear rejected the comment');
  return data.commentCreate.comment.id;
}
