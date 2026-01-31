import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { glob } from 'glob';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const CONFIG = {
    packageName: 'ru.wb.courier',
    
    apkToolPath: 'apktool.jar',
    signerPath: 'signer.jar',
    
    outputApk: 'original.apk',
    decodedDir: 'decoded_app',
    unsignedApk: 'unsigned_mod.apk',
    finalApk: 'wb-mod-final.apk',
    
    keystore: {
        path: 'release-key.jks',
        alias: process.env.KEY_ALIAS,
        password: process.env.KEY_PASSWORD
    },

    replacements: {
        'api/v1/courier/ping': 'https://profit-engine-web.vercel.app/api/wb/ping'
    }
};

const log = (msg: string, type: 'info'|'success'|'warn'|'error' = 'info') => {
    const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
    console.log(`${icons[type]} [WB-BUILDER] ${msg}`);
};

class Patcher {
    
    async download() {
        log(`Запрос версии для ${CONFIG.packageName}...`, 'info');

        try {
            const infoUrl = `https://backapi.rustore.ru/applicationData/overallInfo/${CONFIG.packageName}`;
            const infoRes = await fetch(infoUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            
            if (!infoRes.ok) throw new Error(`Info Error: ${infoRes.statusText}`);
            
            const info = await infoRes.json() as any;
            const { appId, versionId, versionName } = info.body;

            if (!appId || !versionId) {
                console.error('API Response:', JSON.stringify(info));
                throw new Error('Не удалось получить appId или versionId');
            }

            log(`Найдена версия: ${versionName}`, 'success');

            const linkUrl = 'https://backapi.rustore.ru/applicationData/download-link';
            
            const payload = { 
                appId, 
                packageName: CONFIG.packageName, 
                versionId,
                firstInstall: true 
            };
            
            console.log('Sending Payload:', JSON.stringify(payload));

            const linkRes = await fetch(linkUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.rustore.ru',
                    'Referer': 'https://www.rustore.ru/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                body: JSON.stringify(payload)
            });

            if (!linkRes.ok) {
                const errText = await linkRes.text();
                throw new Error(`Link Error: ${linkRes.status} | Body: ${errText}`);
            }
            
            const linkData = await linkRes.json() as any;
            
            log('Скачивание APK...', 'info');
            const downloadRes = await fetch(linkData.body.url);
            if (!downloadRes.ok || !downloadRes.body) throw new Error('Download failed');

            const fileStream = createWriteStream(CONFIG.outputApk);
            // @ts-ignore
            await pipeline(Readable.fromWeb(downloadRes.body), fileStream);
            
            log('Файл скачан успешно.', 'success');

        } catch (error) {
            console.error(error);
            process.exit(1);
        }
    }

    decompile() {
        log('Разборка APK (это может занять время)...', 'info');
        
        if (fs.existsSync(CONFIG.decodedDir)) {
            fs.rmSync(CONFIG.decodedDir, { recursive: true, force: true });
        }

        try {
            execSync(`java -jar ${CONFIG.apkToolPath} d ${CONFIG.outputApk} -o ${CONFIG.decodedDir} -f`, { stdio: 'inherit' });
        } catch (e) {
            log('Ошибка ApkTool. Проверь наличие Java.', 'error');
            process.exit(1);
        }
    }

    async patch() {
        log('Внедрение модификаций...', 'warn');
        
        const smaliFiles = await glob(`${CONFIG.decodedDir}/smali*/**/*.smali`);
        let patchedCount = 0;

        for (const file of smaliFiles) {
            let content = await fs.readFile(file, 'utf-8');
            let isModified = false;

            for (const [original, replacement] of Object.entries(CONFIG.replacements)) {
                if (content.includes(original)) {
                    content = content.replaceAll(original, replacement);
                    isModified = true;
                    log(`API Patched: ${original} -> PROXY в файле ${path.basename(file)}`, 'success');
                }
            }

            if (content.includes('setWebContentsDebuggingEnabled')) {
                const debugRegex = /(const\/4 v\d+, 0x)0(\s+invoke-static \{v\d+\}, Landroid\/webkit\/WebView;->setWebContentsDebuggingEnabled)/;
                if (debugRegex.test(content)) {
                    content = content.replace(debugRegex, '$11$2');
                    isModified = true;
                    log(`WebView Debug Enabled: ${path.basename(file)}`, 'success');
                }
            }

            if (isModified) {
                await fs.writeFile(file, content, 'utf-8');
                patchedCount++;
            }
        }
        
        log(`Всего изменено файлов: ${patchedCount}`, 'info');
    }

    // 4. СБОРКА
    build() {
        log('Сборка нового APK...', 'info');
        try {
            execSync(`java -jar ${CONFIG.apkToolPath} b ${CONFIG.decodedDir} -o ${CONFIG.unsignedApk} --use-aapt2`, { stdio: 'inherit' });
            log(`Собран неподписанный файл: ${CONFIG.unsignedApk}`, 'success');
        } catch (e) {
            log('Ошибка сборки. Смотри логи выше.', 'error');
            process.exit(1);
        }
    }

    // 5. ПОДПИСЬ
    sign() {
        log('Подпись APK твоим ключом...', 'info');

        if (!fs.existsSync(CONFIG.signerPath)) {
            log(`Не найден ${CONFIG.signerPath} (uber-apk-signer)`, 'error');
            process.exit(1);
        }
        if (!fs.existsSync(CONFIG.keystore.path)) {
            log(`Не найден ключ ${CONFIG.keystore.path}! Сгенерируй его через keytool.`, 'error');
            process.exit(1);
        }

        try {
            const args = [
                `-jar ${CONFIG.signerPath}`,
                `--apks ${CONFIG.unsignedApk}`,
                `--ks ${CONFIG.keystore.path}`,
                `--ksAlias ${CONFIG.keystore.alias}`,
                `--ksPass ${CONFIG.keystore.password}`,
                `--ksKeyPass ${CONFIG.keystore.password}`,
                `--overwrite`
            ].join(' ');

            execSync(`java ${args}`, { stdio: 'inherit' });

            const signedFile = CONFIG.unsignedApk.replace('.apk', '-aligned-signed.apk');

            if (fs.existsSync(signedFile)) {
                fs.renameSync(signedFile, CONFIG.finalApk);
                
                fs.removeSync(CONFIG.outputApk);
                fs.removeSync(CONFIG.unsignedApk);
                fs.removeSync(CONFIG.decodedDir);

                log(`🎉 ГОТОВО! Файл: ${CONFIG.finalApk}`, 'success');
                log(`ℹ️  Этот файл можно устанавливать поверх предыдущей версии (обновление).`, 'info');
            } else {
                throw new Error('Подписанный файл не найден. Ошибка сайнера.');
            }

        } catch (e) {
            console.error(e);
            process.exit(1);
        }
    }
}

(async () => {
    const patcher = new Patcher();
    await patcher.download();
    patcher.decompile();
    await patcher.patch();
    patcher.build();
    patcher.sign();
})();