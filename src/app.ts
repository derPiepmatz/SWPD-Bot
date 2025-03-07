import BitBucketClient from "./bitBucket/BitBucketClient";
import * as jsonfile from "jsonfile";
import * as fs from "fs";
import PullRequestData from "./bitBucket/types/data/PullRequestData";
import GitClient from "./git/GitClient";
import StyleChecker from "./checkstyle/StyleChecker";
import IntelliJFormatter from "./formatter/IntelliJFormatter";
import AwaitLock from "await-lock";
import GoalConfig from "./maven/types/GoalConfig";
import MavenExecutor from "./maven/MavenExecutor";
import Logger, { setWebhookPings, setWebhookUrl } from "./logger/Logger";

// The token used to log into BitBucket.
const token = (fs.readFileSync("./.token", "utf-8") as unknown as string)
  .replace(/[\r\n\s]+/g, "");

// The webhook url used to log errors in Discord.
const webhookUrl = (fs.readFileSync("./.webhook", "utf-8") as unknown as string)
  .replace(/[\r\n\s]+/g, "");

// The config used to configure the webhook.
const webhookConfig = jsonfile.readFileSync("./webhookconfig.json") as {
  pingsOnError: string[]
}

// The config used to configure the repo to interact with.
const bitBucketConfig = jsonfile.readFileSync("./bitbucketconfig.json") as {
  host: string,
  user: string,
  project: string,
  repo: string,
  name: string,
  email: string,
  isUserRepo: boolean,
  approvalsUntilFormat: number
};

// The config for the formatter to use.
const formatterConfig = jsonfile.readFileSync("./formatterconfig.json") as {
  ideaPath: string
};

// The config for the maven executor, containing all goals
const mavenConfig = jsonfile.readFileSync("./mavenconfig.json") as {
  cmd: string,
  goals: GoalConfig[]
}

// Anonymous async function to allow top-level await calls.
(async function() {
  // A lock to make sure only one operation modifying files is used at the same
  // time.
  const lock = new AwaitLock();

  setWebhookUrl(webhookUrl);
  setWebhookPings(webhookConfig.pingsOnError);

  const bbClient = new BitBucketClient(
    bitBucketConfig.host,
    bitBucketConfig.user,
    token,
    bitBucketConfig.project,
    bitBucketConfig.repo,
    bitBucketConfig.isUserRepo);

  const gitClient = new GitClient(
    BitBucketClient.extractCloneURL(await bbClient.fetchRepository()) as string,
    bitBucketConfig.user,
    bitBucketConfig.name,
    bitBucketConfig.email,
    token
  );

  const styleChecker = new StyleChecker();

  const formatter = new IntelliJFormatter(
    formatterConfig.ideaPath
  );

  const mavenExecutor = new MavenExecutor(mavenConfig.cmd, bitBucketConfig.repo);

  const logger = new Logger("APP");

  // Small helper function to fetch the diffs and get their full paths.
  async function fetchDiffSources(pullRequestId: number): Promise<string[]> {
    let diffResponse = await bbClient.fetchDiff(pullRequestId);
    let sources: Array<string> = [];
    for (let diff of diffResponse.diffs) {
      if (diff.source === null) continue;
      sources.push(diff.source.toString);
    }
    return gitClient.extendRepoPaths(sources);
  }

  // This will start the heartbeat of the BitBucket client to allow listening to
  // it's events.
  logger.info("Will start with the Heartbeat now!");
  bbClient.startHeartbeat();

  bbClient.on("heartbeat", () => {
    logger.verbose("Heartbeat for the BitBucket Client");
  });

  bbClient.on("prCreate", async (pullRequest: PullRequestData) => {
    // When a pull request is opened the bot shall fetch the diffs and run a
    // style check over it. The output of the check shall be commented under the
    // pull request.

    logger.info(`Pull Request #${pullRequest.id} was created on BitBucket`);

    let extendedSources = await fetchDiffSources(pullRequest.id);

    await lock.acquireAsync(); // Files should be frozen here.

    await gitClient.forceCheckout(pullRequest.fromRef.displayId);
    await gitClient.pull();

    logger.info("Checking modified Files for Style Conflicts");
    let checks = await styleChecker.runChecks(extendedSources);

    lock.release(); // Files can be modified again.

    // Prepare the markdown comment.
    let markdownArray: Array<string> = [];
    for (let check of checks) {
      markdownArray.push(check.toMarkdown());
    }
    if (markdownArray.length !== 0) {
      // If there is at least one thing to comment, it will be.
      let markdownString = markdownArray.join("\n");
      await bbClient.commentPullRequest(markdownString, pullRequest.id);
      logger.info(`Commented that ${markdownArray.length} Conflicts were found`);
      return;
    }

    // Also post a comment if no conflicts were found.
    let okString = "**✔️ No checkstyle conflicts found.** ";
    await bbClient.commentPullRequest(okString, pullRequest.id);
    logger.info("Commented that no Conflicts were found");
  });

  bbClient.on("prClose", (pullRequest: PullRequestData) => {
    logger.info(`Pull Request #${pullRequest.id} was closed`);
  });

  bbClient.on("prUpdate", async (oldPR: PullRequestData, newPR: PullRequestData) => {
    // When the pull request updates the listener checks for the amount of
    // approvals. If the amount reaches the first time it's needed high the bot
    // will perform a format. If there any formatted files, they will be
    // committed and pushed.

    logger.info(`Pull Request #${oldPR.id} was updated`);

    // Helper function to count the approvals of a pull request.
    function getApprovalCount(pr: PullRequestData): number {
      let approvalCount = 0;
      for (let reviewer of pr.reviewers) {
        if (reviewer.approved) approvalCount++;
      }
      logger.debug(`Approvals for Pull Request #${pr.id} was ${approvalCount}`);
      return approvalCount;
    }

    if (getApprovalCount(oldPR) < bitBucketConfig.approvalsUntilFormat) {
      // Check if the old PR had NOT enough approvals.
      if (getApprovalCount(newPR) >= bitBucketConfig.approvalsUntilFormat) {
        // Check if the new one has enough approvals.

        logger.info("Starting the Formatter now!");
        // Fetch differences and run the formatter.
        let extendedSources = await fetchDiffSources(oldPR.id);
        logger.debug("Found Diffs: " + extendedSources.join(" "));
        await lock.acquireAsync();
        await gitClient.forceCheckout(oldPR.fromRef.displayId);
        let javaSources =
          extendedSources.filter(source => source.endsWith(".java"));
        logger.debug("Filtered Diffs: " + javaSources.join(" "));
        await formatter.format(javaSources);
        logger.info("Formatted everything successfully");

        logger.info("Executing configured Maven Goals now!");
        try {
          await mavenExecutor.executeGoals(mavenConfig.goals);
        }
        catch (e) {
          await bbClient.commentPullRequest(
            "**❗ A required maven goal failed. " +
            "Will stop now.**", oldPR.id)
          logger.error("A required maven goal failed.");
          lock.release();
          return;
        }
        logger.info("Executed Maven goals successfully!");

        try {
          // Commit everything.
          await gitClient.commitAll("Auto-Reformat PR#" + oldPR.id,
            "This action was performed automatically by a bot.");
          logger.info("Committed formatted Code");
        }
        catch (e) {
          // If it cannot commit, probably there is nothing to commit.
          await bbClient
            .commentPullRequest("**👌 Nothing to format.**", oldPR.id);
          logger.info("Found nothing to commit");
          lock.release();
          return;
        }

        try {
          // Push changes.
          await gitClient.push();
          logger.info("Pushed formatted Code");
        }
        catch (e) {
          // If it could not push, comment it.
          // Also stash the possible changes.
          await bbClient
            .commentPullRequest("**⚠️ Could not push changes.**", oldPR.id);
          logger.warn("Could not push formatted Code");
          await gitClient.stash();
        }
        lock.release();
      }
    }
  });
})();
