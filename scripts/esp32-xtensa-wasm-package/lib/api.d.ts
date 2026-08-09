export type Tree = {
  [name: string]: Tree | string | Uint8Array;
};

export type InputStream = (byteLength: number) => Uint8Array | null;
export type OutputStream = (bytes: Uint8Array | null) => void;
export type ProgressCallback = (event: {
  source: object;
  totalLength: number;
  doneLength: number;
}) => void;

export type RunOptions = {
  stdin?: InputStream | null;
  stdout?: OutputStream | null;
  stderr?: OutputStream | null;
  decodeASCII?: boolean;
  synchronously?: boolean;
  fetchProgress?: ProgressCallback;
};

export type Command = (
  args?: string[] | null,
  files?: Tree,
  options?: RunOptions,
) => Promise<Tree> | Tree | undefined;

export class Exit extends Error {
  code: number;
  files: Tree;
}

export const runLLVM: Command;
export const runClang: Command;
export const commands: Readonly<Record<string, Command>> & {
  clang: Command;
  'clang++': Command;
};
export const version: string;
