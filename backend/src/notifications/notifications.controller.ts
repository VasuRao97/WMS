import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';

// No @Roles() on either handler — every authenticated user can see/
// acknowledge only their OWN notifications (enforced in the service via
// recipientUserId), same "self access always allowed, no role gate needed"
// shape as a User editing their own account.
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findMine(@CurrentUser() user: any, @Query('unacknowledgedOnly') unacknowledgedOnly?: string) {
    return this.notificationsService.listMine(user, unacknowledgedOnly === 'true');
  }

  @Patch(':id/acknowledge')
  acknowledge(@Param('id') id: string, @CurrentUser() user: any) {
    return this.notificationsService.acknowledge(id, user);
  }
}
