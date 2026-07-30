import { SetMetadata } from '@nestjs/common';
import { PUBLIC_ROUTE } from './auth.guard.js';

export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
