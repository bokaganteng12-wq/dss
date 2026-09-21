const express = require('express');
const mongoose = require('mongoose');
const midtransClient = require('midtrans-client');
require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    EmbedBuilder, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    StringSelectMenuBuilder,
    InteractionType,
    PermissionFlagsBits
} = require('discord.js');

// --- 1. SETUP EXPRESS, MONGODB & MIDTRANS ---
const app = express();
app.use(express.json());

const coreApi = new midtransClient.CoreApi({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

app.get('/', (req, res) => {
    res.send('🚀 BOBOHUB API Server is Online and Running!');
});

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Terhubung ke MongoDB'))
    .catch(err => console.error('❌ Gagal terhubung ke MongoDB:', err));

const keySchema = new mongoose.Schema({
    keyString: { type: String, required: true, unique: true },
    hwid: { type: String, default: null }, 
    discordId: { type: String, default: null }, 
    durationDays: { type: Number, default: 1 },
    resetCount: { type: Number, default: 0 }, 
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null }
});

const KeyModel = mongoose.model('BoboHubKeys', keySchema);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// --- 2. API ENDPOINT UNTUK VERIFIKASI ROBLOX (AUTO-BIND HWID) ---
app.post('/api/verify', async (req, res) => {
    const { key, hwid } = req.body;

    if (!key || !hwid) {
        return res.status(400).json({ success: false, message: 'Key dan HWID wajib diisi!' });
    }

    try {
        const foundKey = await KeyModel.findOne({ keyString: key });

        if (!foundKey) {
            return res.status(404).json({ success: false, message: 'Key tidak valid atau tidak ditemukan!' });
        }

        if (foundKey.expiresAt && new Date() > foundKey.expiresAt) {
            return res.status(400).json({ success: false, message: 'Key sudah kedaluwarsa!' });
        }

        if (!foundKey.discordId) {
            return res.status(403).json({ success: false, message: 'Key belum di-redeem di Discord! Silakan redeem melalui bot terlebih dahulu.' });
        }

        if (!foundKey.hwid) {
            foundKey.hwid = hwid;
            await foundKey.save();
            return res.json({ success: true, message: 'HWID berhasil terdaftar secara otomatis! Verifikasi berhasil.' });
        }

        if (foundKey.hwid === hwid) {
            return res.json({ success: true, message: 'Verifikasi berhasil!' });
        } else {
            return res.status(403).json({ success: false, message: 'Akses ditolak! Key ini sudah terkunci di perangkat lain.' });
        }

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: 'Kesalahan pada server internal.' });
    }
});

// --- 2.1 MIDTRANS NOTIFICATION WEBHOOK (OTOMATIS BUAT KEY & KIRIM KE DM + CHANNEL) ---
app.post('/api/notification', async (req, res) => {
    try {
        const notificationResponse = await coreApi.transaction.notification(req.body);
        const orderId = notificationResponse.order_id;
        const transactionStatus = notificationResponse.transaction_status;
        const fraudStatus = notificationResponse.fraud_status;

        console.log(`🔔 Notifikasi Midtrans diterima untuk Order ID: ${orderId}, Status:${transactionStatus}`);

        if (transactionStatus == 'settlement' || (transactionStatus == 'capture' && fraudStatus == 'accept')) {
            const parts = orderId.split('-');
            if (parts.length >= 3) {
                const durationDays = parseInt(parts[1].replace('D', '')) || 1;
                const discordId = parts[2];

                const randomString = Math.random().toString(36).substring(2, 8).toUpperCase();
                const keyName = `BOBOHUB-${durationDays}D-${randomString}-2026`;

                await KeyModel.create({
                    keyString: keyName,
                    durationDays: durationDays,
                    discordId: discordId
                });

                // 1. Kirim Key via DM ke User
                try {
                    const user = await client.users.fetch(discordId);
                    if (user) {
                        await user.send(`🎉 **Pembayaran Berhasil!** Terima kasih telah membeli akses BOBOHUB.\n\n🔑 **Key Anda:** \`${keyName}\`\n⏳ **Durasi:** ${durationDays} Hari\n\nSilakan gunakan tombol **Redeem Key** di server Discord untuk mengaktifkannya!`);
                        console.log(`✅ Key ${keyName} berhasil dikirim via DM ke user${discordId}`);
                    }
                } catch (dmErr) {
                    console.error(`⚠️ Gagal mengirim DM ke user ${discordId}, tapi key sudah dibuat:${keyName}`);
                }

                // 2. Kirim Notifikasi Publik ke Channel Discord Utama
                try {
                    const targetChannelId = process.env.CHANNEL_ID;
                    if (targetChannelId) {
                        const channel = await client.channels.fetch(targetChannelId);
                        if (channel) {
                            const successEmbed = new EmbedBuilder()
                                .setTitle('🎉 Pembayaran Berhasil & Dana Masuk!')
                                .setDescription(`Pengguna <@${discordId}> telah berhasil membeli akses **BOBOHUB** durasi **${durationDays} Hari** via QRIS!\n\n🔑 *Key telah dikirimkan secara otomatis ke DM pembeli.*`)
                                .setColor(0x00FF00)
                                .setTimestamp();

                            await channel.send({ embeds: [successEmbed] });
                        }
                    }
                } catch (channelErr) {
                    console.error('⚠️ Gagal mengirim pengumuman ke channel publik:', channelErr);
                }
            }
        }

        return res.status(200).json({ status: 'OK' });
    } catch (error) {
        console.error('❌ Midtrans Webhook Error:', error);
        return res.status(500).json({ status: 'error', message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));

// --- 4. DISCORD BOT EVENT READY ---
client.once('ready', async () => {
    console.log(`🤖 Discord Bot aktif sebagai ${client.user.tag}`);

    const targetChannelId = process.env.CHANNEL_ID;
    const adminRoleId = process.env.ADMIN_ROLE_ID;

    if (!targetChannelId) {
        return console.log('❌ CHANNEL_ID belum diatur di dalam file .env!');
    }
    
    try {
        const channel = await client.channels.fetch(targetChannelId);
        if (!channel) return console.log('❌ Channel panel tidak ditemukan!');

        await channel.permissionOverwrites.set([
            {
                id: channel.guild.id,
                deny: [PermissionFlagsBits.SendMessages],
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
            },
            {
                id: adminRoleId,
                allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
            },
            {
                id: client.user.id,
                allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
            }
        ]).catch(() => {});

        const messages = await channel.messages.fetch({ limit: 10 });
        await channel.bulkDelete(messages, true).catch(() => {});

        const embed = new EmbedBuilder()
            .setTitle('🎮 BOBOHUB Key System')
            .setDescription('Welcome to BOBOHUB Key System!\n\nUse the buttons below to get your key or manage your account.')
            .addFields(
                { name: 'Access Pricing:', value: '• 1 Day = Rp7,400\n• 7 Days = Rp31,600\n• 30 Days = Rp68,500' }
            )
            .setColor(0x5865F2);

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_access').setLabel('Access').setStyle(ButtonStyle.Success).setEmoji('💎'),
            new ButtonBuilder().setCustomId('btn_redeem').setLabel('Redeem Key').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
            new ButtonBuilder().setCustomId('btn_script').setLabel('Get Script').setStyle(ButtonStyle.Secondary).setEmoji('📜')
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_reset').setLabel('Reset HWID').setStyle(ButtonStyle.Danger).setEmoji('⚙️'),
            new ButtonBuilder().setCustomId('btn_mykeys').setLabel('My Keys').setStyle(ButtonStyle.Secondary).setEmoji('📊')
        );

        await channel.send({ embeds: [embed], components: [row1, row2] });
        console.log('✅ Panel BOBOHUB dikirim dan channel utama dikunci (Read-Only)!');

    } catch (error) {
        console.error('❌ Gagal mengatur channel otomatis:', error);
    }
});

// --- 5. COMMAND ADMIN (!genkey & !clear) ---
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const adminRoleId = process.env.ADMIN_ROLE_ID; 
    const isAdmin = message.member.roles.cache.has(adminRoleId) || message.member.permissions.has(PermissionFlagsBits.Administrator);

    if (message.content.startsWith('!genkey')) {
        if (!isAdmin) {
            return message.reply('❌ Anda tidak memiliki izin untuk menggunakan perintah ini!');
        }

        const args = message.content.split(' ');
        const targetUser = message.mentions.users.first();
        const duration = parseInt(args[2]) || 1;

        if (!targetUser) {
            return message.reply('⚠️ Format salah! Contoh: `!genkey @Username 7`');
        }

        const randomString = Math.random().toString(36).substring(2, 8).toUpperCase();
        const keyName = `BOBOHUB-${duration}D-${randomString}-2026`;

        try {
            await KeyModel.create({ 
                keyString: keyName, 
                durationDays: duration,
                discordId: targetUser.id 
            });

            try {
                await targetUser.send(`🎁 **Halo ${targetUser.username}!** Anda telah menerima Key **BOBOHUB** dari Admin.\n\n🔑 **Key Anda:** \`${keyName}\`\n⏳ **Durasi:** ${duration} Hari\n\nSilakan redeem melalui panel di server Discord menggunakan tombol **Redeem Key**!`);
                message.reply(`✅ Berhasil! Key \`${keyName}\` (${duration} Hari) telah dibuat dan dikirim via **DM** ke ${targetUser}.`);
            } catch (dmError) {
                message.reply(`⚠️ Key \`${keyName}\` berhasil dibuat di database, tetapi **gagal mengirim DM** ke ${targetUser} (DM tertutup). Key: \`${keyName}\``);
            }
        } catch (err) {
            console.error(err);
            message.reply('❌ Gagal membuat key (kemungkinan duplikat, coba lagi).');
        }
    }

    if (message.content.startsWith('!clear')) {
        if (!isAdmin) {
            return message.reply('❌ Khusus Admin BOBOHUB!');
        }

        const args = message.content.split(' ');
        let deleteCount = parseInt(args[1]) || 10;
        if (deleteCount > 100) deleteCount = 100;

        try {
            await message.delete().catch(() => {});
            const fetched = await message.channel.messages.fetch({ limit: deleteCount });
            
            const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
            const validMessages = fetched.filter(msg => msg.createdTimestamp > twoWeeksAgo);

            await message.channel.bulkDelete(validMessages, true);

            const replyMsg = await message.channel.send(`🧹 Berhasil menghapus **${validMessages.size}** pesan.`);
            setTimeout(() => replyMsg.delete().catch(() => {}), 3000);
        } catch (err) {
            console.error(err);
            message.reply('❌ Gagal menghapus pesan.');
        }
    }
});

// --- 6. HANDLE INTERAKSI TOMBOL, MENU, & MODAL ---
client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        if (interaction.customId === 'btn_access') {
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_duration')
                .setPlaceholder('Pilih durasi akses untuk pembayaran QRIS...')
                .addOptions([
                    { label: '1 Day - Rp7,400', value: '1_7400' },
                    { label: '7 Days - Rp31,600', value: '7_31600' },
                    { label: '30 Days - Rp68,500', value: '30_68500' }
                ]);

            const row = new ActionRowBuilder().addComponents(selectMenu);

            const embed = new EmbedBuilder()
                .setTitle('💎 BOBOHUB Instant Access (QRIS Sandbox)')
                .setDescription('Silakan pilih durasi akses di bawah ini untuk memunculkan QRIS pembayaran otomatis.\n\n**Pricing:**\n• 1 Day = Rp7,400\n• 7 Days = Rp31,600\n• 30 Days = Rp68,500')
                .setColor(0x00FF00);

            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        if (interaction.customId === 'btn_reset') {
            const modal = new ModalBuilder()
                .setCustomId('modal_reset')
                .setTitle('BOBOHUB Reset HWID');

            const keyInput = new TextInputBuilder()
                .setCustomId('input_reset_key')
                .setLabel('Masukkan Key yang ingin di-reset HWID-nya')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('BOBOHUB-7D-XXXXXX-2026')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
            await interaction.showModal(modal);
        }

        if (interaction.customId === 'btn_redeem') {
            const modal = new ModalBuilder()
                .setCustomId('modal_redeem')
                .setTitle('BOBOHUB Redeem Key');

            const keyInput = new TextInputBuilder()
                .setCustomId('input_key')
                .setLabel('Enter your license key')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('BOBOHUB-7D-XXXXXX-2026')
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(keyInput)
            );
            await interaction.showModal(modal);
        }

        if (interaction.customId === 'btn_script') {
            await interaction.reply({ 
                content: '📜 **BOBOHUB Script Loadstring:**\n`https://raw.githubusercontent.com/bokaganteng12-wq/idv/refs/heads/main/idv`', 
                ephemeral: true 
            });
        }

        if (interaction.customId === 'btn_mykeys') {
            await interaction.deferReply({ ephemeral: true });
            const userKeys = await KeyModel.find({ discordId: interaction.user.id });
            if (userKeys.length === 0) {
                return interaction.editReply({ content: '❌ Anda belum memiliki atau me-redeem key BOBOHUB apapun.' });
            }

            let desc = userKeys.map(k => `• **Key:** \`${k.keyString}\`\n  **HWID Terkunci:** \`${k.hwid || 'Belum di-bind'}\`\n  **Sisa Reset:** ${2 - k.resetCount} kali\n  **Expired:** ${k.expiresAt ? k.expiresAt.toLocaleString() : 'Belum aktif'}`).join('\n\n');
            
            await interaction.editReply({ content: `📊 **Daftar Key BOBOHUB Anda:**\n\n${desc}` });
        }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_duration') {
        await interaction.deferReply({ ephemeral: true });
        const [durationDays, amount] = interaction.values[0].split('_');

        try {
            const orderId = `BOBO-${durationDays}D-${interaction.user.id}-${Date.now()}`;
            const parameter = {
                "payment_type": "qris",
                "transaction_details": {
                    "order_id": orderId,
                    "gross_amount": parseInt(amount)
                },
                "qris": { "acquirer": "gopay" }
            };

            const chargeResponse = await coreApi.charge(parameter);
            const qrImageUrl = chargeResponse.actions && chargeResponse.actions[0] ? chargeResponse.actions[0].url : null;

            const embed = new EmbedBuilder()
                .setTitle('📱 Scan QRIS untuk Pembayaran')
                .setDescription(`Durasi: **${durationDays} Hari**\nTotal: **Rp${parseInt(amount).toLocaleString()}**\n\nSilakan scan QR Code di bawah menggunakan e-wallet (GoPay, DANA, OVO, m-Banking) berlogo QRIS (Sandbox).\n\n*(Key akan **otomatis dikirim via DM** & pengumuman sukses akan muncul di channel setelah pembayaran berhasil!)*`)
                .setImage(qrImageUrl)
                .setColor(0xFFA500);

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error(error);
            await interaction.editReply({ content: '❌ Gagal membuat tagihan QRIS Midtrans. Pastikan Server Key Sandbox Anda valid di dalam file .env.' });
        }
    }

    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'modal_redeem') {
        const inputKey = interaction.fields.getTextInputValue('input_key');

        try {
            const foundKey = await KeyModel.findOne({ keyString: inputKey });

            if (!foundKey) {
                return interaction.reply({ content: '❌ Key BOBOHUB tidak valid atau tidak ditemukan di database!', ephemeral: true });
            }

            if (foundKey.discordId && foundKey.discordId !== interaction.user.id) {
                return interaction.reply({ content: '❌ Key ini sudah digunakan oleh akun Discord lain!', ephemeral: true });
            }

            const expireDate = new Date();
            expireDate.setDate(expireDate.getDate() + foundKey.durationDays);
            
            foundKey.discordId = interaction.user.id;
            foundKey.expiresAt = expireDate;
            await foundKey.save();

            return interaction.reply({ 
                content: `✅ **Berhasil Redeem BOBOHUB!** Key Anda berhasil diaktifkan.\n📅 **Masa Aktif Hingga:** ${expireDate.toLocaleString()}\n\n*(HWID akan otomatis terkunci saat pertama kali menjalankan script di Roblox)*`, 
                ephemeral: true 
            });

        } catch (err) {
            console.error(err);
            return interaction.reply({ content: '❌ Terjadi kesalahan pada server saat memproses redeem key.', ephemeral: true });
        }
    }

    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'modal_reset') {
        const inputKey = interaction.fields.getTextInputValue('input_reset_key');

        try {
            const foundKey = await KeyModel.findOne({ keyString: inputKey });

            if (!foundKey) {
                return interaction.reply({ content: '❌ Key BOBOHUB tidak valid atau tidak ditemukan di database!', ephemeral: true });
            }

            if (foundKey.discordId && foundKey.discordId !== interaction.user.id) {
                return interaction.reply({ content: '❌ Key ini terdaftar atas kepunyaan akun Discord lain!', ephemeral: true });
            }

            if (foundKey.resetCount >= 2) {
                return interaction.reply({ 
                    content: `❌ **Batas Reset Habis!** Key ini sudah melakukan reset HWID sebanyak **${foundKey.resetCount}x** (Maksimal 2 kali).`, 
                    ephemeral: true 
                });
            }

            foundKey.hwid = null;
            foundKey.resetCount += 1;
            await foundKey.save();

            const sisaReset = 2 - foundKey.resetCount;

            return interaction.reply({ 
                content: `✅ **Berhasil Reset HWID!** HWID perangkat Anda sebelumnya telah dihapus.\n🔄 Sisa jatah reset Anda: **${sisaReset} kali lagi**.\n\n*(HWID baru akan otomatis terkunci saat Anda kembali menjalankan script di Roblox)*`, 
                ephemeral: true 
            });

        } catch (err) {
            console.error(err);
            return interaction.reply({ content: '❌ Terjadi kesalahan pada server saat memproses reset HWID.', ephemeral: true });
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
