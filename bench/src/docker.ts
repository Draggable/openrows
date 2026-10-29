import { execFileSync } from 'node:child_process';

/** Server settings for a 16 GB / 8 vCPU box; recorded in the results so runs are comparable. */
export const PG_SETTINGS: Record<string, string> = {
  shared_buffers: '2GB',
  effective_cache_size: '8GB',
  work_mem: '32MB',
  maintenance_work_mem: '512MB',
  max_wal_size: '8GB',
  random_page_cost: '1.1',
  max_connections: '200',
  jit: 'off',
};

export interface Container {
  name: string;
  url: string;
  exec(args: string[]): string;
  remove(): void;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function startPostgres(image: string): Container {
  const name = `openrows-bench-${process.pid}`;
  const settings = Object.entries(PG_SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--shm-size=1g',
    '-e',
    'POSTGRES_PASSWORD=bench',
    '-e',
    'POSTGRES_DB=bench',
    '-p',
    '127.0.0.1::5432',
    image,
    'postgres',
    ...settings,
  ]);
  const port = docker(['port', name, '5432/tcp']).trim().split('\n')[0]?.split(':').pop();
  if (!port) throw new Error('Could not read the mapped Postgres port');
  return {
    name,
    url: `postgres://postgres:bench@127.0.0.1:${port}/bench`,
    exec: (args) => docker(['exec', name, ...args]),
    remove: () => {
      try {
        docker(['rm', '-f', name]);
      } catch {
        // already gone
      }
    },
  };
}
