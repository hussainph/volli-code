export interface Api {
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}

declare global {
  interface Window {
    api: Api;
  }
}
