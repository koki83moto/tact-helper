// TACT のページを開いたことをバックグラウンドに通知する(ログイン中に同期するため)
chrome.runtime.sendMessage({ type: 'tactVisited' }).catch(() => {});
