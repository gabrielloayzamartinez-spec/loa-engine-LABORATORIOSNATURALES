/**
 * LOA Engine v1.0
 * Copyright (c) 2026 LOA Agency. Todos los derechos reservados.
 * Queda estrictamente prohibida la copia, modificación o distribución 
 * de este código sin autorización expresa de LOA Agency.
 * 
 * SecurityValidator: Sistema de validación de Licencia Comercial.
 * Protege el software contra piratería o instalaciones no autorizadas.
 */

import crypto from 'crypto';

export class SecurityValidator {
    
    // Hash maestro (simulado para la licencia de producción)
    static MASTER_LICENSE_HASH = '1f1882fb36d07d1cf6a7f05eb43d4c728e2354728d11c1d8c117dcf49c4f6974'; // "LOA-GHL-2026-PROD"

    /**
     * Verifica que el entorno tenga una llave de activación válida 
     * antes de permitir que el LOA Engine encienda.
     */
    static validateLicense() {
        const key = process.env.LOA_LICENSE_KEY;
        
        if (!key) {
            this.triggerLockdown('NO_LICENSE_KEY_FOUND', 'Licencia no encontrada. Contacte a soporte de LOA Agency.');
        }

        const hashedKey = crypto.createHash('sha256').update(key).digest('hex');

        if (hashedKey !== this.MASTER_LICENSE_HASH) {
            this.triggerLockdown('INVALID_LICENSE_KEY', 'La llave de licencia proporcionada ha expirado o es inválida.');
        }

        console.log('====================================================');
        console.log('🔒 LOA ENGINE: LICENCIA COMERCIAL VALIDADA CON ÉXITO');
        console.log('© 2026 LOA Agency. Software Protegido.');
        console.log('====================================================');
        return true;
    }

    /**
     * Bloquea la ejecución del proceso si hay fraude de licencia.
     */
    static triggerLockdown(errorCode, message) {
        console.error('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        console.error(`🛑 ALERTA DE SEGURIDAD [${errorCode}]`);
        console.error(message);
        console.error('El motor LOA Engine ha sido bloqueado por seguridad.');
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
        process.exit(1); // Apaga el servidor Node.js de inmediato
    }

    /**
     * Middleware de Express para inyectar la firma digital en los headers.
     */
    static getSignatureMiddleware() {
        return (req, res, next) => {
            res.setHeader('X-Powered-By', 'LOA Engine v1.0 (Enterprise Edition)');
            res.setHeader('X-LOA-Copyright', 'LOA Agency 2026');
            next();
        };
    }
}
