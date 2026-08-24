import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async registerCompany(data: {
    companyName: string;
    companyCode: string;
    adminName: string;
    email: string;
    password: string;
  }) {
    if (!data.companyName || !data.companyCode || !data.adminName || !data.email || !data.password) {
      throw new BadRequestException('companyName, companyCode, adminName, email, and password are all required.');
    }

    const existingCompany = await this.prisma.company.findUnique({ where: { code: data.companyCode } });
    if (existingCompany) {
      throw new BadRequestException(`Company code "${data.companyCode}" is already taken.`);
    }

    const existingUser = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existingUser) {
      throw new BadRequestException(`Email "${data.email}" is already registered.`);
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    const company = await this.prisma.company.create({
      data: {
        name: data.companyName,
        code: data.companyCode,
        users: {
          create: {
            email: data.email,
            passwordHash,
            name: data.adminName,
            role: 'COMPANY_ADMIN',
          },
        },
      },
      include: { users: true },
    });

    const adminUser = company.users[0];
    await this.recordLogin(adminUser.id);
    return this.buildAuthResponse(adminUser.id, adminUser.email, adminUser.role, company.id);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.recordLogin(user.id);
    return this.buildAuthResponse(user.id, user.email, user.role, user.companyId);
  }

  // Append-only login ledger (LoginEvent, mirrors StockMovement's "never
  // UPDATE, always INSERT" pattern) plus the cached lastLoginAt convenience
  // field on User, kept in sync in the same transaction so they never drift.
  // First-level capture for a future manpower-attendance report — the
  // report/rollup itself isn't built yet, this just makes sure the history
  // exists to build it from later. Called from both login() and
  // registerCompany() (registration auto-logs the new Admin in too).
  private async recordLogin(userId: string) {
    await this.prisma.$transaction([
      this.prisma.loginEvent.create({ data: { userId } }),
      this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } }),
    ]);
  }

  private buildAuthResponse(userId: string, email: string, role: string, companyId: string | null) {
    const payload = { sub: userId, email, role, companyId };
    const token = this.jwtService.sign(payload);
    return { accessToken: token, user: { id: userId, email, role, companyId } };
  }
}