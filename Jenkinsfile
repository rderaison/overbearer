pipeline {
    agent any

    parameters {
        string(name: 'OVERBEARER_REGISTRY', defaultValue: 'ghcr.io/rderaison/overbearer', description: 'Container image registry')
        string(name: 'OVERBEARER_REGISTRY_CREDS', defaultValue: 'GHCR_IO_LOGIN', description: 'Jenkins credentials ID for docker login')
        string(name: 'IMAGE_TAG', defaultValue: '', description: 'Docker image tag (leave empty to auto-generate from branch/build)')
        booleanParam(name: 'TAG_AS_LATEST', defaultValue: false, description: 'Also tag this build as "latest"')
    }

    environment {
        REGISTRY           = "${params.OVERBEARER_REGISTRY}"
        REGISTRY_CREDS_ID  = "${params.OVERBEARER_REGISTRY_CREDS}"
        IMAGE_TAG          = "${params.IMAGE_TAG ?: ((env.BRANCH_NAME ?: 'main') == 'main' ? 'latest' : env.BRANCH_NAME + '-' + env.BUILD_NUMBER)}"
        DOCKER_API_VERSION = '1.43'
        BUILDX_PLATFORMS   = 'linux/amd64,linux/arm64'
    }

    stages {
        stage('Setup Buildx') {
            steps {
                sh '''
                    docker buildx create --name multiarch --use --bootstrap 2>/dev/null || \
                    docker buildx use multiarch
                '''
            }
        }

        stage('Registry Login') {
            steps {
                script {
                    def registryHost = REGISTRY.split('/')[0]
                    if (REGISTRY_CREDS_ID == 'DOCKER_SECLIO_REGISTRY') {
                        withCredentials([file(credentialsId: REGISTRY_CREDS_ID, variable: 'DOCKER_CONFIG_FILE')]) {
                            sh "mkdir -p \$HOME/.docker && cp \$DOCKER_CONFIG_FILE \$HOME/.docker/config.json"
                        }
                    } else {
                        withCredentials([usernamePassword(credentialsId: REGISTRY_CREDS_ID, usernameVariable: 'USER', passwordVariable: 'TOKEN')]) {
                            sh "echo \$TOKEN | docker login ${registryHost} -u \$USER --password-stdin"
                        }
                    }
                }
            }
        }

        stage('Build & Push Images') {
            parallel {
                stage('Proxy Image') {
                    steps {
                        script {
                            def tags = "--tag ${REGISTRY}/proxy:${IMAGE_TAG}"
                            if (params.TAG_AS_LATEST && IMAGE_TAG != 'latest') {
                                tags += " --tag ${REGISTRY}/proxy:latest"
                            }
                            sh """
                                docker buildx build \
                                    --platform ${BUILDX_PLATFORMS} \
                                    -f Dockerfile.proxy \
                                    ${tags} \
                                    --push \
                                    .
                            """
                        }
                    }
                }
                stage('Management Image') {
                    steps {
                        script {
                            def tags = "--tag ${REGISTRY}/management:${IMAGE_TAG}"
                            if (params.TAG_AS_LATEST && IMAGE_TAG != 'latest') {
                                tags += " --tag ${REGISTRY}/management:latest"
                            }
                            sh """
                                docker buildx build \
                                    --platform ${BUILDX_PLATFORMS} \
                                    -f Dockerfile.api \
                                    ${tags} \
                                    --push \
                                    .
                            """
                        }
                    }
                }
            }
        }
    }

    post {
        always {
            sh 'docker buildx prune -f --filter="until=24h" || true'
        }
        failure {
            echo 'Build failed!'
        }
        success {
            echo "Images: ${REGISTRY}/proxy:${IMAGE_TAG}, ${REGISTRY}/management:${IMAGE_TAG}"
        }
    }
}
