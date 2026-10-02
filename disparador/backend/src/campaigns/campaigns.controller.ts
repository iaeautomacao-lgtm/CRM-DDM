import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Request, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CampaignsService } from './campaigns.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('Campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  findAll(@Query('status') status?: string, @Query('page') page = '1', @Query('limit') limit = '20') {
    return this.campaignsService.findAll({ status, page: parseInt(page), limit: parseInt(limit) });
  }

  @Post()
  create(@Body() body: any, @Request() req: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || ['created_by','approved_by','approved_at','account_id','status','id'].some(key => key in body))
      throw new BadRequestException('Campos internos não podem ser informados');
    return this.campaignsService.create(body, req.user.sub);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.campaignsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    const editable = new Set(['nome','tipo_campanha','descricao','session_id','session_ids','modo_envio','intervalo_min','intervalo_max','limite_por_hora','janela_inicio','janela_fim','dias_permitidos','mensagens','agendamento','batch_size','batch_pause_seconds','config']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !editable.has(key)))
      throw new BadRequestException('Campo de campanha não permitido');
    return this.campaignsService.update(id, body);
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @Request() req: any) {
    return this.campaignsService.approve(id, req.user.sub);
  }

  @Post(':id/start')
  start(@Param('id') id: string) {
    return this.campaignsService.start(id);
  }

  @Post(':id/requeue')
  requeue(@Param('id') id: string) {
    return this.campaignsService.requeue(id);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.campaignsService.pause(id);
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.campaignsService.stop(id);
  }

  @Post(':id/contacts')
  addContacts(@Param('id') id: string, @Body('contact_ids') contactIds: string[]) {
    return this.campaignsService.addContacts(id, contactIds);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.campaignsService.delete(id);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string, @Request() req: any) {
    return this.campaignsService.duplicate(id, req.user.sub);
  }
}
