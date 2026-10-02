import { Injectable, ExecutionContext, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly config: ConfigService, private readonly supabase: SupabaseService) { super(); }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!await super.canActivate(context)) return false;
    const account = this.config.get<string>('DISPATCH_SINGLE_ACCOUNT_ID');
    if (!account) throw new ServiceUnavailableException('Configure a conta exclusiva deste serviço legado');
    const request = context.switchToHttp().getRequest();
    const { data: profile, error } = await this.supabase.db.schema('wacrm').from('profiles')
      .select('account_id,account_role').eq('user_id', request.user.sub).maybeSingle();
    if (error || profile?.account_id !== account) throw new ForbiddenException('Conta não autorizada');
    const role = profile.account_role;
    if (!['owner','admin','agent','viewer'].includes(role)) throw new ForbiddenException();
    if (request.method !== 'GET' && role === 'viewer') throw new ForbiddenException('Acesso somente de leitura');
    if ((request.method === 'DELETE' || /\/(approve|sessions|users)(\/|$)/.test(request.url)) && !['owner','admin'].includes(role))
      throw new ForbiddenException('Permissão administrativa necessária');
    request.user.accountId = account;
    request.user.accountRole = role;
    return true;
  }
}
