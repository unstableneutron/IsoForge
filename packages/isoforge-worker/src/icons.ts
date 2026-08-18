export interface IconDescriptor {
  id: string;
  name: string;
  pack: string;
  tags: string[];
}

// Stable discovery vocabulary. The editor resolves these identifiers through
// its bundled Isoflow packs; no filesystem or Node resolution is required.
export const ICONS: IconDescriptor[] = [
  ['server', 'Server', 'isoflow', ['compute', 'host']],
  ['database', 'Database', 'isoflow', ['storage', 'sql']],
  ['client', 'Client', 'isoflow', ['user', 'browser']],
  ['cloud', 'Cloud', 'isoflow', ['internet']],
  ['firewall', 'Firewall', 'isoflow', ['security', 'network']],
  ['router', 'Router', 'isoflow', ['network']],
  ['switch', 'Switch', 'isoflow', ['network']],
  ['queue', 'Message Queue', 'isoflow', ['messaging', 'event']],
  ['container', 'Container', 'isoflow', ['docker', 'runtime']],
  ['kubernetes', 'Kubernetes', 'isoflow', ['k8s', 'orchestration']],
  ['aws-ec2', 'Amazon EC2', 'aws', ['compute', 'vm']],
  ['aws-lambda', 'AWS Lambda', 'aws', ['function', 'serverless']],
  ['aws-s3', 'Amazon S3', 'aws', ['object', 'storage', 'bucket']],
  ['aws-rds', 'Amazon RDS', 'aws', ['database', 'sql']],
  ['aws-dynamodb', 'Amazon DynamoDB', 'aws', ['database', 'nosql']],
  ['aws-api-gateway', 'Amazon API Gateway', 'aws', ['api', 'gateway']],
  ['aws-cloudfront', 'Amazon CloudFront', 'aws', ['cdn', 'edge']],
  ['gcp-compute-engine', 'Google Compute Engine', 'gcp', ['compute', 'vm']],
  ['gcp-cloud-run', 'Google Cloud Run', 'gcp', ['container', 'serverless']],
  ['gcp-cloud-storage', 'Google Cloud Storage', 'gcp', ['object', 'storage', 'bucket']],
  ['gcp-cloud-sql', 'Google Cloud SQL', 'gcp', ['database', 'sql']],
  ['gcp-pubsub', 'Google Pub/Sub', 'gcp', ['messaging', 'event']]
].map(([id, name, pack, tags]) => ({ id: id as string, name: name as string, pack: pack as string, tags: tags as string[] }));

export function searchIcons(query = '', pack?: string, limit = 20): IconDescriptor[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return ICONS.filter(icon => !pack || icon.pack === pack)
    .map(icon => ({ icon, haystack: `${icon.id} ${icon.name} ${icon.pack} ${icon.tags.join(' ')}`.toLowerCase() }))
    .filter(({ haystack }) => terms.every(term => haystack.includes(term)))
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map(({ icon }) => icon);
}
