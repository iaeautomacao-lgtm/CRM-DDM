/** Storage path validation must accompany message ownership and account-id checks. */
export function isOwnedChatMediaPath(path:string,accountId:string):boolean {
 return (path.startsWith('account-'+accountId+'/') || /^meta\/[^/]+$/.test(path)) &&
   !path.split('/').some(p=>p==='..'||p==='.'||!p||p.includes('\\'));
}
