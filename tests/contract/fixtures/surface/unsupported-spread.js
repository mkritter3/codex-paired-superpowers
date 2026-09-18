const subcommands = {
  alpha(args) {
    process.stdout.write(JSON.stringify({ ok: true, ...args }));
  },
};
