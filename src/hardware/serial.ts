import { SerialPort } from 'serialport';
import { Configurator } from '../cli/configurator.js';
import { ui } from '../cli/ui.js';

export class SerialBridge {
  private port: SerialPort | null = null;

  public async connect(portPath: string, baudRate: number = 9600): Promise<void> {
    const config = await Configurator.init();

    if (!config.security.allowedPorts.includes(portPath) && config.security.mode !== 'full') {
      ui.error(`Serial port ${portPath} is not whitelisted. Connection blocked.`);
      throw new Error(`Unwhitelisted port: ${portPath}`);
    }

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({ path: portPath, baudRate }, (err) => {
        if (err) {
          ui.error(`Failed to open serial port: ${err.message}`);
          return reject(err);
        }
        ui.success(`Connected to serial port ${portPath} at ${baudRate} baud.`);
        resolve();
      });

      this.port.on('data', (data) => {
        // Handle incoming telemetry asynchronously
        ui.info(`[Serial Data]: ${data.toString()}`);
      });
    });
  }

  public async sendCommand(data: string): Promise<void> {
    if (!this.port) throw new Error('Serial port not connected');
    
    return new Promise((resolve, reject) => {
      this.port?.write(data, (err) => {
        if (err) {
          ui.error(`Failed to send data to serial port: ${err.message}`);
          return reject(err);
        }
        resolve();
      });
    });
  }

  public close() {
    if (this.port && this.port.isOpen) {
      this.port.close();
    }
  }
}

export const serialBridge = new SerialBridge();
