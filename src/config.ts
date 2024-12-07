import minimist from 'minimist';
import path from 'path';

export interface Config {
  claudeDesktopMode: boolean;
  workDir: string;
  spacePaths: string[];
  hfToken?: string;
}

export const config = parseConfig();

export function parseConfig(): Config {
  const argv = minimist(process.argv.slice(2), {
    string: ['work-dir', 'hf-token'],
    boolean: ['desktop-mode'],
    default: {
      'desktop-mode': process.env.CLAUDE_DESKTOP_MODE !== 'false',
      'work-dir': process.env.WORK_DIR || process.cwd(),
      'hf-token': process.env.HF_TOKEN,
    },
    '--': true,
  });

  return {
    claudeDesktopMode: argv['desktop-mode'],
    workDir: path.resolve(argv['work-dir']),
    hfToken: argv['hf-token'],
    spacePaths: argv._.length > 0 
      ? argv._
      : ["black-forest-labs/FLUX.1-schnell"]
  };
}