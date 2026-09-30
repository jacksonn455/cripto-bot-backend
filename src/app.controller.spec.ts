import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { tradingConfig } from './config/configuration';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: tradingConfig.KEY, useValue: { mode: 'PAPER' } },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return trading mode info', () => {
      expect(appController.getInfo()).toEqual(
        expect.objectContaining({ tradingMode: 'PAPER' }),
      );
    });
  });
});
