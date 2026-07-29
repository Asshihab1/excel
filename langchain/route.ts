import { Routes } from '@nestjs/core';
import { LangchainModule } from '@module/langchain/langchain.module';

export const LangchainRoutes: Routes = [
  {
    path: 'langchain',
    module: LangchainModule,
  },
];
